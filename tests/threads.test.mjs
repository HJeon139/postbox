// Threads’ interface (designs/architecture/services.md, “Threads”): conversations, topic and side threads, their items,
// and presence. Its invariants: an item has one live copy (bringForward leaves a stub); a topic’s reply count follows
// each message; a thread’s lineage ends at its conversation. It signals item.added and item.moved on the bus. Built on
// an in-memory store and a bus that records what was emitted; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';

/** A bus that records each signal, in order. */
function recordingBus() {
  const emitted = [];
  return { emitted, on() {}, emit: (signal, data) => emitted.push([signal, data]) };
}

/** Threads over an empty store with one project and one conversation, `th_c`, and a bus that records. */
function rig() {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: null });
  const bus = recordingBus();
  const threads = new Threads({ store, bus });
  const conv = threads.put(thread('th_c'));
  return { store, bus, threads, conv };
}

/** A thread record as Postbox writes one. @param {string} id @param {object} [more] */
function thread(id, more = {}) {
  return { id, projectId: 'p1', title: id, kind: 'thread', parentId: null, members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: 1, ...more };
}

/** Asserts that `fn` throws an HTTP error with that status. */
function refused(fn, status) {
  assert.throws(fn, (/** @type {any} */ e) => e.status === status);
}

const signals = (bus, name) => bus.emitted.filter(([s]) => s === name).map(([, d]) => d);

// ── Threads ──────────────────────────────────────────────────────────────────────────

test('get answers a thread, and a 404 for one that doesn’t exist', () => {
  const { threads } = rig();
  assert.equal(threads.get('th_c').title, 'th_c');
  refused(() => threads.get('th_nowhere'), 404);
});

test('create starts a conversation in a project, with no members yet, and refuses a project that doesn’t exist', () => {
  const { store, threads } = rig();
  const t = threads.create({ projectId: 'p1', title: '' });
  assert.equal(store.state.threads[t.id].title, 'New conversation');
  assert.equal(t.kind, 'thread');
  assert.equal(t.parentId, null);
  assert.deepEqual(t.members, []);
  refused(() => threads.create({ projectId: 'p_nowhere', title: 'X' }), 404);
});

test('patch writes a thread with the change, from the thread as it is, and returns it', () => {
  const { store, threads } = rig();
  assert.equal(threads.patch('th_c', { hops: 2 }).hops, 2);
  assert.equal(threads.patch('th_c', (t) => ({ hops: t.hops + 1 })).hops, 3, 'a function of the thread gets it as written');
  assert.equal(store.state.threads.th_c.hops, 3);
  assert.equal(
    threads.patch('th_c', () => null),
    undefined,
    'null writes nothing',
  );
  assert.equal(threads.patch('th_nowhere', { hops: 1 }), undefined, 'a thread that doesn’t exist isn’t written');
  assert.equal(store.state.threads.th_nowhere, undefined);
});

test('toWrite answers the thread a write is about to change, or a 404; pending lists every thread', () => {
  const { threads } = rig();
  assert.equal(threads.toWrite('th_c').id, 'th_c');
  refused(() => threads.toWrite('th_nowhere'), 404);
  assert.deepEqual(
    threads.pending().map((t) => t.id),
    ['th_c'],
  );
});

test('rename names a thread, trimmed and cut to 120 characters, and refuses an empty name', () => {
  const { store, threads } = rig();
  threads.rename('th_c', `  ${'n'.repeat(130)}  `);
  assert.equal(store.state.threads.th_c.title, 'n'.repeat(120));
  refused(() => threads.rename('th_c', '   '), 422);
  refused(() => threads.rename('th_nowhere', 'X'), 404);
});

// ── Items ────────────────────────────────────────────────────────────────────────────

test('addItem gives an item an id and a time, keeps what it was given, and signals item.added before it returns', () => {
  const { store, bus, threads } = rig();
  // #1334: the person’s message keeps whom it was for.
  const it = threads.addItem('th_c', { kind: 'user', text: 'Hi', to: ['alpha'] });
  assert.match(it.id, /^it/);
  assert.equal(typeof it.at, 'number');
  assert.deepEqual(store.items('th_c'), [it]);
  assert.deepEqual(store.items('th_c')[0].to, ['alpha']);
  const added = signals(bus, 'item.added');
  assert.equal(added.length, 1);
  assert.equal(added[0].threadId, 'th_c');
  assert.equal(added[0].item, it);
  assert.equal(added[0].thread.id, 'th_c', 'the listener gets the thread it was added to');
});

test('addItem in a topic thread counts each message on the item it branched from, and nothing else', () => {
  const { store, threads } = rig();
  const root = threads.addItem('th_c', { kind: 'agent', text: 'A topic.' });
  threads.put(thread('th_t', { kind: 'topic', parentId: 'th_c', rootItemId: root.id }));
  threads.addItem('th_t', { kind: 'user', text: 'One' });
  threads.addItem('th_t', { kind: 'system', variant: 'joined', to: 'beta' });
  const last = threads.addItem('th_t', { kind: 'agent', text: 'Two' });
  const counted = store.item('th_c', root.id);
  assert.equal(counted.replies, 2);
  assert.equal(counted.lastReplyAt, last.at);
});

test('patchItem changes an item in place', () => {
  const { store, threads } = rig();
  const it = threads.addItem('th_c', { kind: 'agent', text: 'Draft', status: 'streaming' });
  threads.patchItem('th_c', it.id, { status: 'done' });
  assert.equal(store.item('th_c', it.id).status, 'done');
});

test('bringForward moves an item to the end with its id, leaves one stub in its place, and signals item.moved', () => {
  const { store, bus, threads } = rig();
  const a = threads.addItem('th_c', { kind: 'block', text: 'Asks' });
  const b = threads.addItem('th_c', { kind: 'agent', text: 'Later' });
  assert.equal(threads.bringForward('th_c', a.id, { what: 'block', title: 'Asks' }, { v: 2 }), true);
  const items = store.items('th_c');
  assert.deepEqual(
    items.map((x) => x.kind),
    ['moved', 'agent', 'block'],
  );
  assert.equal(items.filter((x) => x.id === a.id).length, 1, 'one live copy');
  assert.equal(items[0].itemId, a.id, 'the stub leads to it');
  assert.equal(items[2].v, 2, 'it takes the patch as it moves');
  assert.equal(items[1].id, b.id);
  assert.deepEqual(signals(bus, 'item.moved'), [{ threadId: 'th_c', id: a.id, stubId: items[0].id }]);
});

test('bringForward of the newest item only patches it, and of an item that isn’t there does nothing; neither signals', () => {
  const { store, bus, threads } = rig();
  const a = threads.addItem('th_c', { kind: 'block', text: 'Asks' });
  assert.equal(threads.bringForward('th_c', a.id, { what: 'block', title: 'Asks' }, { v: 2 }), false);
  assert.equal(store.item('th_c', a.id).v, 2);
  assert.equal(threads.bringForward('th_c', 'it_nowhere', { what: 'block', title: 'X' }), false);
  assert.equal(store.items('th_c').length, 1);
  assert.deepEqual(signals(bus, 'item.moved'), []);
});

// ── A thread’s place in its conversation ─────────────────────────────────────────────

test('lineage runs from a thread to its conversation; conversationThreads lists the lineage, then its other threads', () => {
  const { threads } = rig();
  threads.put(thread('th_t', { kind: 'topic', parentId: 'th_c' }));
  threads.put(thread('th_s', { kind: 'side', parentId: 'th_c' }));
  threads.put(thread('th_other'));
  assert.deepEqual(threads.lineage('th_t'), ['th_t', 'th_c']);
  assert.deepEqual(threads.lineage('th_c'), ['th_c']);
  assert.deepEqual(threads.conversationThreads('th_t'), ['th_t', 'th_c', 'th_s']);
  assert.deepEqual(
    threads.lineage('th_t', (id) => (id === 'th_t' ? { parentId: null } : undefined)),
    ['th_t'],
    'a lookup of its own',
  );
});

test('glossaryFor gives a thread its conversation’s terms under its own, its own winning', () => {
  const { store, threads } = rig();
  threads.put(thread('th_t', { kind: 'topic', parentId: 'th_c' }));
  store.emit('glossary', { threadId: 'th_c', entry: { key: 'api', term: 'API', def: 'the conversation’s' } });
  store.emit('glossary', { threadId: 'th_c', entry: { key: 'db', term: 'DB', def: 'a database' } });
  store.emit('glossary', { threadId: 'th_t', entry: { key: 'api', term: 'API', def: 'the topic’s' } });
  const g = threads.glossaryFor('th_t');
  assert.equal(g.api.def, 'the topic’s');
  assert.equal(g.db.def, 'a database');
});

// ── Notifications, presence and reactions ────────────────────────────────────────────

test('notify sends a notification for the session’s thread, or the one given', () => {
  const { store, threads } = rig();
  const heard = [];
  store.subscribe((ev) => ev.type === 'notify' && heard.push(ev.data));
  const se = { id: 'se_1', threadId: 'th_c', handle: 'alpha' };
  threads.notify('info', se, 'Title', 'Text');
  threads.notify('blocking', se, 'Asks', 'More', 'th_t');
  assert.deepEqual(heard, [
    { level: 'info', sessionId: 'se_1', threadId: 'th_c', handle: 'alpha', title: 'Title', text: 'Text' },
    { level: 'blocking', sessionId: 'se_1', threadId: 'th_t', handle: 'alpha', title: 'Asks', text: 'More' },
  ]);
});

test('view marks a thread as open and clears its unread count; isViewing holds for 20 seconds', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { store, threads } = rig();
  threads.patch('th_c', { unread: 3 });
  assert.equal(threads.isViewing('th_c'), false);
  threads.view('th_c');
  assert.equal(store.state.threads.th_c.unread, 0);
  assert.equal(threads.isViewing('th_c'), true);
  t.mock.timers.tick(19_999);
  assert.equal(threads.isViewing('th_c'), true);
  t.mock.timers.tick(1);
  assert.equal(threads.isViewing('th_c'), false);
});

test('toggleReaction adds a reactor’s reaction, and takes it back the second time', () => {
  const { store, threads } = rig();
  const it = threads.addItem('th_c', { kind: 'agent', text: 'Done.', status: 'done' });
  assert.equal(threads.toggleReaction('th_c', it.id, '👍').on, true);
  assert.deepEqual(
    store.item('th_c', it.id).reactions.map((r) => r.emoji),
    ['👍'],
  );
  assert.equal(threads.toggleReaction('th_c', it.id, '👍').on, false);
  assert.deepEqual(store.item('th_c', it.id).reactions, []);
  refused(() => threads.toggleReaction('th_c', it.id, 'not an emoji'), 422);
});
