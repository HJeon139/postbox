// Apps’ interface (designs/architecture/services.md, “Apps”): agents’ apps, their versions, saved state, host data and
// the browser’s check, blocks shown and updated, review comments, and which answers an agent has read. Built on an
// in-memory store, the real Bus, Threads and Running, fakes of Sessions, Personas, Assets and Checks, and a `send` port
// that records what it was given; it never builds Runtime. The app-send cards are asks’, so an event past an app’s
// limit comes back to be held, and nothing is sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_SEND_LIMIT } from '../server/app-send-limits.mjs';
import { Apps } from '../server/app-service.mjs';
import { Bus } from '../server/bus.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';

const CODE = '<p>Lab</p>';

/** Apps over a store with one agent in a conversation; `blobs` is what the asset store holds, by hash. */
function rig({ tools = [], blobs = { f1: Buffer.from('data') } } = {}) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  store.emit('thread', { id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: ['se_1', 'se_2'], queue: [], createdAt: 1 });
  store.emit('session', { id: 'se_1', personaId: 'pe_a', threadId: 'th_c', handle: 'alpha', backend: 'mock', lastTurnId: 'tu_0' });
  store.emit('session', { id: 'se_2', personaId: 'pe_b', threadId: 'th_c', handle: 'beta', backend: 'mock' });
  const bus = new Bus();
  /** @type {[string, any][]} */
  const signals = [];
  for (const s of ['app.retired', 'block.withdrawn']) bus.on(s, (data) => signals.push([s, data]));
  const threads = new Threads({ store, bus });
  const running = new Running();
  const sessions = {
    get: (/** @type {string} */ id) => {
      const se = store.state.sessions[id];
      if (!se) throw Object.assign(new Error('That session doesn’t exist.'), { status: 404 });
      return se;
    },
  };
  const personas = { forSession: () => ({ handle: 'alpha', tools }) };
  /** @type {any[]} */
  const searched = [];
  const assets = {
    blobs: blobs && { get: async (/** @type {string} */ sha) => blobs[sha] },
    search: async (room, args) => {
      searched.push([room, args]);
      return [{ name: 'a.md' }];
    },
    listText: async () => [],
  };
  /** @type {any[]} */
  const linted = [];
  const checks = { lint: (sessionId, turnId, problems) => linted.push({ sessionId, turnId, problems }) };
  /** @type {any[]} */
  const sent = [];
  const send = (sessionId, message, opts) => sent.push({ sessionId, message, opts });
  const apps = new Apps({ store, bus, threads, sessions, personas, assets, running, checks, send, narrator: null, config: { imageOrigins: [] } });
  return { store, threads, running, apps, sent, linted, signals, searched };
}

/** Shows an app of alpha’s, as show_app does, and returns its item. */
function shown(apps, threads, { id = 'lab', permissions = [], files = [] } = {}) {
  const it = threads.addItem('th_c', {
    kind: 'block',
    valid: true,
    sessionId: 'se_1',
    handle: 'alpha',
    block: { id, type: 'app', version: 1, title: 'Lab', code: CODE },
  });
  apps.register('se_1', { id, title: 'Lab', code: CODE, permissions }, it.id, 'th_c', files);
  return it;
}

/** The tools’ context for a turn of alpha’s, as toolsFor makes it. */
const ctx = (store) => ({ turn: null, se: () => store.state.sessions.se_1, threadId: () => 'th_c', endSegment() {} });

// ── Apps and their check ─────────────────────────────────────────────────────────────

test('a registered app is v1 and pending; a clean check passes it, and an old version’s report is ignored', () => {
  const { store, threads, apps } = rig();
  shown(apps, threads);
  assert.deepEqual([store.state.apps.lab.current, store.state.apps.lab.check.status], [1, 'pending']);
  assert.deepEqual(apps.appCheck('lab', { version: 2, problems: [] }), { ignored: true });
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems: [] }), { status: 'passed' });
  assert.throws(
    () => apps.appCheck('gone', { version: 1 }),
    (e) => e.status === 404,
  );
});

test('a blocking problem goes back to the agent once as a fix turn, through send; the next version’s is a note, and a script error then crashes it', () => {
  const { store, threads, apps, sent } = rig();
  const it = shown(apps, threads);
  const problems = [{ code: 'text-too-small', message: 'Small text.' }];
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems }), { status: 'fixing' });
  assert.deepEqual(sent, [{ sessionId: 'se_1', message: { kind: 'app-check', appId: 'lab', problems }, opts: { threadId: 'th_c' } }]);
  apps.updateApp(
    'se_1',
    null,
    () => 'th_c',
    () => {},
    { id: 'lab', code: '<p>Lab 2</p>' },
  );
  assert.equal(store.state.apps.lab.current, 2);
  assert.deepEqual(apps.appCheck('lab', { version: 2, problems }), { status: 'note' });
  assert.equal(sent.length, 1, 'no second fix turn');
  apps.updateApp(
    'se_1',
    null,
    () => 'th_c',
    () => {},
    { id: 'lab', code: '<p>Lab 3</p>' },
  );
  assert.deepEqual(apps.appCheck('lab', { version: 3, problems: [{ code: 'script-error', message: 'x is undefined' }] }), { status: 'crashed' });
  assert.equal(store.item('th_c', it.id).block.type, 'app');
});

test('warnings show the app with notes, and the agent hears of them in the lint turn of its running turn, else its last', () => {
  const { threads, running, apps, linted } = rig();
  shown(apps, threads);
  assert.deepEqual(apps.appCheck('lab', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny.' }] }), { status: 'note' });
  assert.equal(linted[0].turnId, 'tu_0', 'the last turn that ended');
  assert.deepEqual(linted[0].problems[0].scope, { kind: 'app', id: 'lab', title: 'Lab' });
  shown(apps, threads, { id: 'lab2' });
  running.begin({ id: 'tu_live', sessionId: 'se_1' });
  apps.appCheck('lab2', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny.' }] });
  assert.equal(linted[1].turnId, 'tu_live');
});

// ── What an app sends, saves and reads ───────────────────────────────────────────────

test('appEvent sends in the person’s voice up to the limit a minute; past it the event comes back to be held, and nothing is sent', () => {
  const { store, threads, apps, sent } = rig();
  shown(apps, threads);
  const now = 1_000_000;
  for (let i = 0; i < APP_SEND_LIMIT; i++) assert.equal(apps.appEvent('lab', 'send', { text: `hi ${i}` }, { now }).ok, true);
  assert.equal(sent.length, APP_SEND_LIMIT);
  assert.deepEqual(sent[0].opts, { threadId: 'th_c' });
  assert.equal(sent[0].message.kind, 'event');
  const held = apps.appEvent('lab', 'send', { text: 'one more' }, { now });
  assert.equal(held.hold.app.id, 'lab');
  assert.equal(held.hold.card, undefined, 'no card yet');
  assert.equal(held.hold.event.event.action, 'send');
  assert.equal(sent.length, APP_SEND_LIMIT, 'nothing more was sent');
  assert.equal(store.items('th_c').filter((x) => x.kind === 'voice').length, APP_SEND_LIMIT);
  assert.equal(apps.appEvent('lab', 'send', { text: 'asked to hold' }, { now: now + 120_000, hold: true }).hold.app.id, 'lab');
});

test('appState saves the app’s state, writes nothing for the same state, and refuses one over 256 KB', () => {
  const { store, threads, apps } = rig();
  shown(apps, threads);
  apps.appState('lab', { n: 1 });
  assert.deepEqual(store.state.apps.lab.state, { n: 1 });
  const before = store.state.apps.lab;
  apps.appState('lab', { n: 1 });
  assert.equal(store.state.apps.lab, before, 'no write');
  assert.throws(
    () => apps.appState('lab', { big: 'x'.repeat(300 * 1024) }),
    (e) => e.status === 413,
  );
});

test('appQuery runs a host tool only when the app asked for it and its agent holds it; every agent holds its room’s assets', async () => {
  const { threads, apps, searched } = rig();
  shown(apps, threads, { permissions: ['assets.search', 'narrate.speak'] });
  assert.deepEqual(await apps.appQuery('lab', 'assets.search', { query: 'q' }), [{ name: 'a.md' }]);
  assert.deepEqual(searched, [['th_c', { query: 'q' }]]);
  assert.throws(
    () => apps.appQuery('lab', 'narrate.speak', {}),
    (e) => e.status === 403,
    'its agent doesn’t hold it',
  );
});

test('appFile reads a version’s data file from the blobs, and is a 404 for a name it doesn’t have or without blobs', async () => {
  const { threads, apps } = rig();
  shown(apps, threads, { files: [{ name: 'data', sha256: 'f1', size: 4 }] });
  assert.equal((await apps.appFile('lab', 'data')).toString(), 'data');
  await assert.rejects(
    () => apps.appFile('lab', 'other'),
    (e) => e.status === 404,
  );
  const none = rig({ blobs: null });
  shown(none.apps, none.threads, { files: [{ name: 'data', sha256: 'f1', size: 4 }] });
  await assert.rejects(
    () => none.apps.appFile('lab', 'data'),
    (e) => e.status === 404,
  );
});

test('appOf is the app an item shows, only on the app’s own item', () => {
  const { threads, apps } = rig();
  const it = shown(apps, threads);
  assert.equal(apps.appOf(it)?.id, 'lab');
  assert.equal(apps.appOf({ ...it, id: 'it_stub' }), null);
});

test('retire signals app.retired with the app as written, after it reads as retired; a new version brings it back', () => {
  const { store, threads, apps, signals } = rig();
  shown(apps, threads);
  assert.equal(apps.retire('se_2', { id: 'lab', reason: 'Done' }).ok, false, 'only the agent that showed it');
  assert.equal(apps.retire('se_1', { id: 'lab', reason: 'Done' }).ok, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0][0], 'app.retired');
  assert.equal(signals[0][1].app.retired.reason, 'Done');
  assert.equal(store.state.apps.lab.retired.by, 'alpha');
  assert.throws(
    () => apps.appEvent('lab', 'send', { text: 'hi' }),
    (e) => e.status === 409,
  );
  apps.updateApp(
    'se_1',
    null,
    () => 'th_c',
    () => {},
    { id: 'lab', code: '<p>Back</p>' },
  );
  assert.equal(store.state.apps.lab.retired, undefined);
});

// ── Blocks ───────────────────────────────────────────────────────────────────────────

test('showBlock shows a block, and an app as a registered app; updateBlock withdrawing one signals block.withdrawn', () => {
  const { store, apps, signals } = rig();
  const block = { id: 'q1', type: 'choice', version: 1, prompt: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] };
  assert.equal(apps.showBlock('se_1', { ...ctx(store), tools: {} }, { block }).ok, true);
  const app = apps.showBlock(
    'se_1',
    { ...ctx(store), tools: {} },
    { block: { id: 'lab', type: 'app', version: 1, title: 'Lab', fallback: 'An app', code: CODE } },
  );
  assert.equal(app.ok, true);
  assert.equal(store.state.apps.lab.current, 1);
  const r = apps.updateBlock('se_1', { block: { id: 'q1', withdraw: 'Not needed any more' } }, ctx(store));
  assert.equal(r.ok, true);
  const it = store.items('th_c').find((x) => x.block?.id === 'q1');
  assert.equal(it.closed.by, 'agent');
  assert.deepEqual(
    signals.map(([s, d]) => [s, d.se.id, d.itemId]),
    [['block.withdrawn', 'se_1', it.id]],
  );
});

test('an answer is read once its event starts a turn; an update over an unread answer is refused, waiting while its event is held', () => {
  const { store, threads, running, apps } = rig();
  const block = { id: 'q1', type: 'choice', version: 1, prompt: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] };
  const it = threads.addItem('th_c', {
    kind: 'block',
    valid: true,
    sessionId: 'se_1',
    handle: 'alpha',
    block,
    answered: true,
    answer: { action: 'choose', values: { choice: 'A' }, voice: 'A', at: 0, revision: 1, read: false },
  });
  running.begin({ id: 'tu_1', sessionId: 'se_1', pending: [{ message: { blockItemId: it.id } }] });
  const waiting = apps.updateBlock('se_1', { block: { ...block, prompt: 'Pick again' } }, ctx(store));
  assert.equal(waiting.ok, false);
  assert.match(waiting.message, /reaches you when this turn ends/);
  apps.answerDelivered('th_c', { kind: 'event', blockItemId: it.id, event: { revision: 1 } });
  assert.equal(store.item('th_c', it.id).answer.read, true);
});

test('reviewBlock comments on another agent’s review and tells it through send; a send that throws is said in the reply', () => {
  const { store, threads, apps, sent } = rig();
  const review = { id: 'rv', type: 'review', version: 1, format: 'markdown', title: 'Draft', content: 'one\ntwo\n' };
  threads.addItem('th_c', { kind: 'block', valid: true, sessionId: 'se_1', handle: 'alpha', block: review });
  const r = apps.reviewBlock('se_2', { blockId: 'rv', comments: [{ line: 1, text: 'Shorter.' }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].sessionId, sent[0].message.event.action, sent[0].message.event.from], ['se_1', 'review', 'beta']);
  const failing = rig();
  failing.threads.addItem('th_c', { kind: 'block', valid: true, sessionId: 'se_1', handle: 'alpha', block: review });
  failing.apps.send = () => {
    throw new Error('Postbox is closing');
  };
  assert.match(failing.apps.reviewBlock('se_2', { blockId: 'rv', comments: [{ line: 1, text: 'x' }] }).message, /didn’t hear them: Postbox is closing/);
  assert.equal(store.items('th_c').at(-1).reviews.length, 1);
});
