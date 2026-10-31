// The pages’ live stream (server/live-streams.mjs, stream()): what a browser gets when it connects with a Last-Event-ID
// ahead of the store, which a restart after an optimistic emit makes an expected state, and when the store emits while
// its backlog is being read (#553’s review, blocker 3 and the stream attach race). These run the in-memory store.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { Store } from '../server/store.mjs';

/** A request and a response that keep what was written, as the server sees them. @param {Record<string, string>} headers */
function connection(headers = {}) {
  const req = /** @type {any} */ (Object.assign(new EventEmitter(), { headers }));
  const written = [];
  const res = /** @type {any} */ ({
    writeHead() {},
    write: (s) => written.push(String(s)),
    destroy() {},
  });
  // Each frame as `event name` or `id:seq event name`, keep-alives, the status line and the epoch frame aside.
  const frames = () =>
    written
      .join('')
      .split('\n\n')
      .filter((f) => f && !f.startsWith(':') && !f.startsWith('retry') && !f.startsWith('event: store') && !f.startsWith('event: epoch'))
      .map((f) => {
        const id = /^id: (\d+)/m.exec(f)?.[1];
        const ev = /^event: (\S+)/m.exec(f)?.[1];
        return id ? `${id}:${ev}` : ev;
      });
  /** The epochs the stream named. */
  const epochs = () =>
    written
      .join('')
      .split('\n\n')
      .filter((f) => f.startsWith('event: epoch'))
      .map((f) => JSON.parse(f.split('data: ')[1]));
  return { req, res, frames, epochs };
}

/** @param {import('node:test').TestContext} t */
function setup(t) {
  const store = new Store(null);
  const live = liveStreams(store);
  t.after(() => live.stop());
  for (let i = 0; i < 3; i++) store.emit('thread', { id: `t${i}`, members: [] });
  return { store, live };
}

test('a browser behind gets the events it missed, then the live ones', async (t) => {
  const { store, live } = setup(t);
  const c = connection({ 'last-event-id': '1' });
  await live.stream(c.req, c.res, new URL('http://x/api/stream'));
  store.emit('thread', { id: 't3', members: [] });
  assert.deepEqual(c.frames(), ['2:thread', '3:thread', '4:thread']);
});

test('a browser ahead of the store (a restart dropped what it saw) is told to resync, not left to drop every later event', async (t) => {
  const { store, live } = setup(t);
  const c = connection({ 'last-event-id': '9' });
  await live.stream(c.req, c.res, new URL('http://x/api/stream'));
  assert.deepEqual(c.frames(), ['resync']);
  // Exactly at the store’s seq is current, not ahead.
  const d = connection();
  await live.stream(d.req, d.res, new URL('http://x/api/stream?since=3'));
  store.emit('thread', { id: 't3', members: [] });
  assert.deepEqual(d.frames(), ['4:thread']);
});

test('an emit while the backlog is being read reaches the new stream exactly once, after the backlog', async (t) => {
  const { store, live } = setup(t);
  // After a restart the backlog comes from Redis; here the read is held so an emit can land during it.
  let release = () => {};
  const held = new Promise((ok) => (release = ok));
  const backlog = store.backlog.bind(store);
  store.backlog = async (seq) => {
    const got = await backlog(seq);
    await held; // the reply is on its way when the emit lands
    return got;
  };
  const c = connection({ 'last-event-id': '1' });
  const opened = live.stream(c.req, c.res, new URL('http://x/api/stream'));
  store.emit('thread', { id: 'during', members: [] });
  release();
  await opened;
  store.emit('thread', { id: 'after', members: [] });
  assert.deepEqual(c.frames(), ['2:thread', '3:thread', '4:thread', '5:thread']);
});

// gpt’s r2 review of #553, blocker 2: the stream sent `running`, awaited the backlog, then joined the subscribers; an
// outage in between reached neither, so the page kept a stale running status.
test('a connection hears the current store outage if it starts while the backlog is awaited', async () => {
  let release = () => {};
  const gate = new Promise((ok) => (release = ok));
  let status = /** @type {any} */ ({ state: 'running' });
  const store = /** @type {any} */ ({
    state: { seq: 1 },
    get status() {
      return status;
    },
    subscribe() {},
    watchers: new Set(),
    backlog: async () => {
      await gate;
      return [];
    },
    since: () => [],
  });
  const live = liveStreams(store);
  const c = connection();
  const written = [];
  c.res.write = (s) => written.push(String(s));
  try {
    const opening = live.stream(c.req, c.res, new URL('http://x/api/stream?since=1'));
    status = { state: 'down', cause: 'died', message: 'store stopped' };
    for (const fn of store.watchers) fn(false, status);
    release();
    await opening;
  } finally {
    live.stop();
  }
  const statuses = written
    .join('')
    .split('\n\n')
    .filter((s) => s.startsWith('event: store'))
    .map((s) => JSON.parse(s.split('data: ')[1]));
  assert.equal(statuses.at(-1)?.state, 'down', 'the stream attached after the outage broadcast and retained its stale running status');
});

for (const seq of [1, 3])
  test(`a state replacement during stream attachment forces resync even when its seq is ${seq}`, async (t) => {
    const { store, live } = setup(t);
    let release = () => {};
    const gate = new Promise((ok) => (release = ok));
    const backlog = store.backlog.bind(store);
    store.backlog = async (since) => {
      const old = await backlog(since);
      await gate;
      return old;
    };
    const c = connection({ 'last-event-id': '1' });
    const opening = live.stream(c.req, c.res, new URL('http://x/api/stream'));
    // Repair replaces the state and clears replay memory; the resync goes out before this stream is attached.
    store.state = { ...store.state, seq };
    store.events.length = 0;
    for (const fn of store.reloads) fn();
    release();
    await opening;
    assert.deepEqual(c.frames(), ['resync'], 'no events from the replaced state reach the connecting page');
    store.emit('thread', { id: 'after-reload', members: [] });
    assert.deepEqual(c.frames(), ['resync', `${seq + 1}:thread`], 'the connection still receives subsequent live changes');
  });

// The integrator’s re-review of #553, blocker 3: a Last-Event-ID alone can’t tell a tab on a lost timeline from one
// that’s merely behind. After a restart, startup emits before any tab reconnects (the “Interrupted by a restart”
// patches, expiries), so the seq passes the tab’s id and it gets the backlog after its own id, keeping events the
// store lost. A repair’s reload can drop an event and leave the seq where it was (#567, folded in here). So the store
// has a history epoch, a token new at every readback of Redis (a restart’s load, a repair’s reload), which /api/state
// and the stream carry and the page echoes; a mismatch is a resync whatever the seq.

/** A tab’s reconnect: its last seq and the epoch it loaded. @param {number} since @param {string} epoch */
const tab = (since, epoch) => connection({ 'last-event-id': String(since), 'x-postbox-epoch': epoch });

test('#553 blocker 3: a tab from before a restart is told to resync even once the restarted store’s seq has passed its id', async (t) => {
  const { store: before, live: old } = setup(t); // the store before the restart, at seq 3
  const epoch = before.epoch;
  assert.ok(typeof epoch === 'string' && epoch.length >= 8, `every store has an epoch: ${epoch}`);
  old.stop();
  // The restart: Redis had taken only two of the three events, and startup emits two more before any tab reconnects.
  const { store, live } = setup(t);
  store.emit('thread', { id: 'interrupted', members: [] });
  assert.notEqual(store.epoch, epoch, 'a readback makes a new epoch');
  const c = tab(3, epoch);
  await live.stream(c.req, c.res, new URL('http://x/api/stream'));
  assert.deepEqual(
    c.frames().filter((f) => f !== 'epoch'),
    ['resync'],
    'the tab’s seq 3 is a lost timeline’s, not this store’s',
  );
});

test('#567: a tab that reconnects at the same seq after a repair’s reload is told to resync; one that already resynced is not', async (t) => {
  const { store, live } = setup(t);
  const epoch = store.epoch;
  // The repair replaced the state from Redis without moving the seq, and told the streams open then.
  store.reloaded(store.state, store.positions);
  assert.notEqual(store.epoch, epoch);
  const stale = tab(3, epoch);
  await live.stream(stale.req, stale.res, new URL('http://x/api/stream'));
  assert.deepEqual(
    stale.frames().filter((f) => f !== 'epoch'),
    ['resync'],
  );
  const fresh = tab(3, store.epoch);
  await live.stream(fresh.req, fresh.res, new URL('http://x/api/stream'));
  store.emit('thread', { id: 'after', members: [] });
  assert.deepEqual(
    fresh.frames().filter((f) => f !== 'epoch'),
    ['4:thread'],
    'already on this epoch: nothing to refetch',
  );
});

test('a tab behind on the current epoch gets the gap, no resync; one that names no epoch is served by its seq alone', async (t) => {
  const { store, live } = setup(t);
  const c = tab(1, store.epoch);
  await live.stream(c.req, c.res, new URL('http://x/api/stream'));
  assert.deepEqual(c.frames(), ['2:thread', '3:thread'], 'the gap, no resync');
  assert.deepEqual(c.epochs(), [store.epoch], 'the stream names its epoch in its first frame');
  const d = connection({ 'last-event-id': '2' }); // tools/uat/history.mjs, and a page from before the epoch
  await live.stream(d.req, d.res, new URL('http://x/api/stream'));
  assert.deepEqual(d.frames(), ['3:thread']);
});
