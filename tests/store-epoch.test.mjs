// The store’s history epoch on its Redis (server/store.mjs, server/store-reject.mjs; the integrator’s re-review of
// #553, blocker 3): new at every readback (a restart’s load, a repair’s reload), kept in Redis under `epoch` beside
// `seq`, and the token a tab echoes so the stream can tell a lost timeline from a tab merely behind.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { liveStreams } from '../server/live-streams.mjs';
import { retry } from '../server/store-recover.mjs';
import { open, poison, raw, tmp } from './store-fixture.mjs';

/** What a tab reconnecting with this seq and epoch is sent, as frame names. @param {any} store @param {number} since @param {string} epoch */
async function reconnect(store, since, epoch) {
  const live = liveStreams(store);
  const req = /** @type {any} */ (Object.assign(new EventEmitter(), { headers: { 'last-event-id': String(since), 'x-postbox-epoch': epoch } }));
  const written = [];
  const res = /** @type {any} */ ({ writeHead() {}, write: (s) => written.push(String(s)), destroy() {} });
  try {
    await live.stream(req, res, new URL('http://x/api/stream'));
  } finally {
    live.stop();
  }
  return written
    .join('')
    .split('\n\n')
    .filter((f) => f && !f.startsWith(':') && !f.startsWith('retry') && !f.startsWith('event: store') && !f.startsWith('event: epoch'))
    .map((f) => {
      const id = /^id: (\d+)/m.exec(f)?.[1];
      const ev = /^event: (\S+)/m.exec(f)?.[1];
      return id ? `${id}:${ev}` : ev;
    });
}

/** The epoch Redis holds. @param {any} s */
async function inRedis(s) {
  const c = await raw(s);
  try {
    return await c.call('GET', 'epoch');
  } finally {
    c.close();
  }
}

test('a restart reads Redis back under a new epoch, kept in Redis, and a tab from before it resyncs once the seq has caught up', async () => {
  const dir = await tmp();
  const a = await open(dir);
  for (let i = 0; i < 3; i++) a.emit('thread', { id: `t${i}`, members: [] });
  await a.flush();
  const before = a.epoch;
  assert.equal(await inRedis(a), before, 'the epoch is in Redis beside seq');
  // The tab saw seq 5: two optimistic emits Redis never took before the restart.
  await a.close();
  const b = await open(dir);
  assert.notEqual(b.epoch, before);
  assert.equal(await inRedis(b), b.epoch);
  b.emit('session', { id: 'se1', threadId: 't0', handle: 'x', state: 'idle' }); // startup’s emits, before any tab is back
  b.emit('session.patch', { id: 'se1', patch: { state: 'stopped' } });
  assert.equal(b.state.seq, 5, 'the seq has caught up with the tab’s');
  assert.deepEqual(await reconnect(b, 5, before), ['resync']);
  assert.deepEqual(await reconnect(b, 3, b.epoch), ['4:session', '5:session.patch'], 'a tab on this epoch is merely behind');
});

test('#567: Retry’s repair reloads under a new epoch, so a tab that wasn’t attached resyncs at the same seq', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  poison(s, 'project:bad');
  s.emit('item.add', { threadId: 't', item: { id: 'x', kind: 'user', text: 'one', at: 1 } });
  s.emit('project', { id: 'bad', name: 'poison' });
  s.emit('item.patch', { threadId: 't', id: 'x', patch: { text: 'two' } });
  await s.flush();
  const before = s.epoch;
  const seq = s.state.seq;
  await retry(s);
  assert.equal(s.writable, true, `the repair didn’t finish: ${s.failed?.message}`);
  assert.equal(s.state.seq, seq, 'the refused event is gone, the seq where it was');
  assert.notEqual(s.epoch, before);
  assert.equal(await inRedis(s), s.epoch);
  assert.deepEqual(await reconnect(s, seq, before), ['resync']);
  assert.deepEqual(await reconnect(s, seq, s.epoch), []);
});
