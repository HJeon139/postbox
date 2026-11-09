// #796, #1007: thread writes held behind a commit that fails. tests/thread-write-held.test.mjs holds that two queued
// wakes survive a commit the reducer rejects, in memory; these hold the rest: the log and the stream, for that
// rejection and for a commit whose fsync fails, which closes the store (store-retry.mjs, fail()).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/**
 * The side-thread room on a store whose log sync can be held, with @gamma in it too, and @beta busy in a turn.
 * hold(events) holds a commit of them in its fsync and returns its release, which ends that fsync with the error
 * given, if any, and answers how the commit ended.
 */
async function busyRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const beta = held();
  f.adapter.next.push(beta.step);
  f.rt.sendMessage(f.t.id, { text: '@beta work' });
  for (let i = 0; i < 200 && !f.adapter.calls.length; i++) await sleep(5);
  assert.equal(f.rt.turns.has(f.beta.id), true, '@beta is busy');
  await h.store.flush();
  const hold = async (events) => {
    h.hold();
    const commit = h.store.commit(events);
    await h.atSync;
    return async (/** @type {Error | undefined} */ error) => {
      h.release(error);
      const outcome = await commit.then(
        () => 'committed',
        (e) => e.code,
      );
      await h.store.flush().catch(() => {}); // after an I/O failure the flush rejects with the cause: writes are closed
      return outcome;
    };
  };
  return { ...f, h, gamma, beta, hold };
}

/** The queue texts of the last `thread` event the stream carried for the room, or null if it carried none. */
const streamed = (heard, threadId) => {
  const last = heard.findLast((ev) => ev.type === 'thread' && ev.data.id === threadId);
  return last ? (last.data.queue ?? []).map((q) => q.text) : null;
};

test('held queue writes behind a rejected commit reach the stream after it, in order, and the log a restart reads', async () => {
  const f = await busyRoom();
  const release = await f.hold([{ type: 'nonsense', data: {} }]);
  const heard = [];
  const off = f.store.subscribe((ev) => heard.push(ev));
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.agentWake(f.gamma.id, 'beta', 'Second.');
  assert.equal(streamed(heard, f.t.id), null, 'the stream hears nothing while they’re held');
  assert.equal(await release(), 'EREJECTED', 'the commit failed');
  off();
  assert.deepEqual(streamed(heard, f.t.id), ['First.', 'Second.'], 'released to the stream, in order');
  const dir = f.store.dir;
  await f.store.close(); // before @beta's turn ends, whose drain would empty the queue
  const again = await new Store(dir).load();
  assert.deepEqual(
    again.state.threads[f.t.id].queue.map((q) => q.text),
    ['First.', 'Second.'],
    'the log holds both',
  );
  await again.close();
  f.beta.release();
});

test('held queue writes behind a commit whose fsync fails: memory and the stream have them, the log doesn’t, and Retry agrees with it', async () => {
  const f = await busyRoom();
  const release = await f.hold([{ type: 'settings', data: { theme: 'system' } }]);
  const heard = [];
  const off = f.store.subscribe((ev) => heard.push(ev));
  f.rt.agentWake(f.alpha.id, 'beta', 'First.');
  f.rt.agentWake(f.gamma.id, 'beta', 'Second.');
  assert.equal(await release(Object.assign(new Error('disk sync refused'), { code: 'EIO' })), 'EIO', 'the commit failed with the cause');
  off();
  assert.equal(f.store.writable, false, 'the failure closed the store to writes');
  assert.deepEqual(
    f.store.state.threads[f.t.id].queue.map((q) => q.text),
    ['First.', 'Second.'],
    'fail() released both onto memory, in order',
  );
  assert.deepEqual(streamed(heard, f.t.id), ['First.', 'Second.'], 'and to the stream, so the page shows what memory holds');
  await f.store.reload(); // Retry installs what the disk holds
  assert.deepEqual(f.store.state.threads[f.t.id].queue ?? [], [], 'the log has neither: they were held when the write failed');
  f.beta.release();
  await settle(f.rt);
  await f.store.close();
});
