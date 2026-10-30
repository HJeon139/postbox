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
  // Each frame as `event name` or `id:seq event name`, keep-alives and the status line aside.
  const frames = () =>
    written
      .join('')
      .split('\n\n')
      .filter((f) => f && !f.startsWith(':') && !f.startsWith('retry') && !f.startsWith('event: store'))
      .map((f) => {
        const id = /^id: (\d+)/m.exec(f)?.[1];
        const ev = /^event: (\S+)/m.exec(f)?.[1];
        return id ? `${id}:${ev}` : ev;
      });
  return { req, res, frames };
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
