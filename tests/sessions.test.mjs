// Sessions’ interface (designs/architecture/services.md, “Sessions”): one session per agent per conversation (#228),
// their unread counts, the notices an agent reads at its next turn, and the commands each agent offers. It signals
// session.joined when an agent joins a conversation. Built on an in-memory store, the real Threads, a persona lookup
// over the store and a bus that records; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions } from '../server/sessions.mjs';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';

/** Sessions over a store with one project, a conversation `th_c`, and the personas alpha, beta and gamma. */
function rig() {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  for (const [id, handle, description] of [
    ['pe_a', 'alpha', 'Writes the code.'],
    ['pe_b', 'beta', 'Reviews it.'],
    ['pe_g', 'gamma', 'Tests it.'],
  ])
    store.emit('persona', { id, handle, description, backend: 'mock', model: 'mock', version: 1, retired: false });
  const emitted = [];
  const bus = { on() {}, emit: (signal, data) => emitted.push([signal, data, store.state.threads[data.threadId]?.members.length]) };
  const threads = new Threads({ store, bus });
  const personas = { get: (id) => store.state.personas[id] };
  const sessions = new Sessions({ store, bus, threads, personas });
  threads.put({ id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: 1 });
  return { store, emitted, threads, sessions };
}

/** Asserts that `fn` throws an HTTP error with that status. */
function refused(fn, status) {
  assert.throws(fn, (/** @type {any} */ e) => e.status === status);
}

const joins = (emitted) => emitted.filter(([s]) => s === 'session.joined');

// ── Joining ──────────────────────────────────────────────────────────────────────────

test('ensure gives an agent one session in a conversation, and a second agent makes it a room', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a', { brief: 'Start here.' });
  assert.equal(a.handle, 'alpha');
  assert.equal(a.brief, 'Start here.');
  assert.equal(a.unread, 0);
  assert.equal(sessions.ensure('th_c', 'pe_a').id, a.id, 'the same agent gets the same session');
  assert.equal(store.state.threads.th_c.kind, 'thread');
  const b = sessions.ensure('th_c', 'pe_b');
  assert.deepEqual(store.state.threads.th_c.members, [a.id, b.id]);
  assert.equal(store.state.threads.th_c.kind, 'room');
});

test('ensure signals session.joined once per new session, after it joined the conversation', () => {
  const { emitted, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  sessions.ensure('th_c', 'pe_a');
  const [[, data, members]] = joins(emitted);
  assert.equal(joins(emitted).length, 1, 'joining again signals nothing');
  assert.equal(data.threadId, 'th_c');
  assert.equal(data.session.id, a.id);
  assert.equal(data.persona.handle, 'alpha');
  assert.equal(members, 1, 'the listeners see it a member');
});

test('ensure marks an agent that joined to answer a wake, and refuses an agent or a thread that doesn’t exist', () => {
  const { emitted, sessions } = rig();
  const g = sessions.ensure('th_c', 'pe_g', { joined: { by: 'alpha', in: 'th_c' } });
  assert.equal(g.joinedBy, 'alpha');
  assert.equal(g.joinedIn, 'th_c');
  refused(() => sessions.ensure('th_c', 'pe_nowhere'), 404);
  refused(() => sessions.ensure('th_nowhere', 'pe_a'), 404);
  assert.equal(joins(emitted).length, 1);
});

// ── Reading ──────────────────────────────────────────────────────────────────────────

test('get answers a session or a 404; in and pendingIn list a thread’s sessions in the order they joined', () => {
  const { sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  const b = sessions.ensure('th_c', 'pe_b');
  assert.equal(sessions.get(a.id).handle, 'alpha');
  refused(() => sessions.get('se_nowhere'), 404);
  assert.deepEqual(
    sessions.in('th_c').map((x) => x.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    sessions.pendingIn('th_c').map((x) => x.id),
    [a.id, b.id],
  );
  assert.deepEqual(sessions.in('th_nowhere'), []);
});

test('roomOf lists the other agents of the conversation with their roles, from a topic thread too', () => {
  const { threads, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  sessions.ensure('th_c', 'pe_b');
  threads.put({ id: 'th_t', projectId: 'p1', title: 'T', kind: 'topic', parentId: 'th_c', members: [], queue: [], createdAt: 2 });
  const room = [{ handle: 'beta', role: 'Reviews it.' }];
  assert.deepEqual(sessions.roomOf('th_c', a), room);
  assert.deepEqual(sessions.roomOf('th_t', a), room);
});

test('awayFrom names the thread an ask is in only when it isn’t the session’s own', () => {
  const { sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  assert.deepEqual(sessions.awayFrom(a, 'th_side'), { threadId: 'th_side' });
  assert.deepEqual(sessions.awayFrom(a, 'th_c'), {});
  assert.deepEqual(sessions.awayFrom(a, null), {});
});

// ── Writing ──────────────────────────────────────────────────────────────────────────

test('update writes what changes, from the session as written, and nothing for a session that doesn’t exist', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  sessions.update(a.id, { currentStep: 'Reading' });
  sessions.update(a.id, (se) => ({ toolCount: se.toolCount + 2 }));
  const now = store.state.sessions[a.id];
  assert.equal(now.currentStep, 'Reading');
  assert.equal(now.toolCount, 2);
  assert.equal(typeof now.updatedAt, 'number');
  sessions.update('se_nowhere', { currentStep: 'x' });
  assert.equal(store.state.sessions.se_nowhere, undefined);
});

test('a need written with its item gets the item’s time, so ⌃J can order it (#1155)', () => {
  const { store, threads, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  const card = threads.addItem('th_c', { kind: 'block', text: 'Asks.' });
  sessions.update(a.id, { needs: { kind: 'block', itemId: card.id } });
  assert.deepEqual(store.state.sessions[a.id].needsAt, { itemId: card.id, at: card.at });
});

test('tell leaves a Postbox notice for the agent’s next turn, keeping the last 20', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  for (let i = 0; i < 22; i++) sessions.tell(a.id, `note ${i}`);
  const context = store.state.sessions[a.id].context;
  assert.equal(context.length, 20);
  assert.equal(context.at(-1), '[Postbox] note 21');
});

test('recordCommands keeps an agent’s commands for the / menu, cleaned and without repeats', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  sessions.recordCommands(a.id, [{ name: '/review', description: ' Reviews. ' }, { name: 'review' }, { name: 'bad name!' }, { name: 'doctor', skill: true }]);
  assert.deepEqual(store.state.sessions[a.id].commands.list, [
    { name: 'review', description: 'Reviews.' },
    { name: 'doctor', skill: true },
  ]);
  sessions.recordCommands('se_nowhere', [{ name: 'x' }]);
});

test('markRead clears the unread counts of a thread’s sessions', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  const b = sessions.ensure('th_c', 'pe_b');
  sessions.update(a.id, { unread: 3 });
  sessions.markRead('th_c');
  assert.equal(store.state.sessions[a.id].unread, 0);
  assert.equal(store.state.sessions[b.id].unread, 0);
});

test('remove deletes a session, and one already gone is left alone', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  sessions.remove(a.id);
  assert.equal(store.state.sessions[a.id], undefined);
  sessions.remove(a.id);
});

test('forgetReported drops what the last turn reported when the persona’s backend or model changes, and only then (#1315)', () => {
  const { store, sessions } = rig();
  const a = sessions.ensure('th_c', 'pe_a');
  sessions.update(a.id, { lastModel: 'claude-opus-5-5', lastEffort: 'medium' });
  const was = store.state.personas.pe_a;
  sessions.forgetReported(was, { ...was, description: 'Changed.' });
  assert.equal(store.state.sessions[a.id].lastModel, 'claude-opus-5-5');
  sessions.forgetReported(was, { ...was, model: 'other' });
  assert.equal(store.state.sessions[a.id].lastModel, null);
  assert.equal(store.state.sessions[a.id].lastEffort, null);
});
