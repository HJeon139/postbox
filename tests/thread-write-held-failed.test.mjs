// #796, #1007: writes held behind a commit that fails. tests/thread-write-held.test.mjs holds that two messages waiting
// for a busy agent survive a commit the reducer rejects, in memory; these hold the rest: the log and the stream, for
// that rejection and for a commit whose fsync fails, which closes the store (store-retry.mjs, fail()). Each message is
// its item and an entry in the agent’s inbox since #1404, where the thread’s queue held it before.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
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
  const gamma = arrange.sessionsIn(f.rt, f.t.id).find((x) => x.handle === 'gamma');
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

/** The texts of the person’s entries the stream carried, by their items in `store`, or null if it carried none. */
const streamed = (heard, store, threadId) => {
  const added = heard.filter((ev) => ev.type === 'entry.add' && ev.data.entry.source === 'person' && ev.data.entry.threadId === threadId);
  return added.length ? added.map((ev) => store.item(threadId, ev.data.entry.itemId)?.text) : null;
};
/** The texts of the person’s messages waiting in a store’s state, in any inbox. */
const waitingIn = (store, f) =>
  Object.values(store.state.inbox ?? {})
    .flat()
    .filter((e) => e.source === 'person' && e.state === 'waiting')
    .map((e) => store.item(f.t.id, e.itemId)?.text);

test('the person’s held messages behind a rejected commit reach the stream after it, in order, and the log a restart reads', async () => {
  const f = await busyRoom();
  const release = await f.hold([{ type: 'nonsense', data: {} }]);
  const heard = [];
  const off = f.store.subscribe((ev) => heard.push(ev));
  f.rt.sendMessage(f.t.id, { text: '@beta first' });
  f.rt.sendMessage(f.t.id, { text: '@beta second' });
  assert.equal(streamed(heard, f.store, f.t.id), null, 'the stream hears nothing while they’re held');
  assert.equal(await release(), 'EREJECTED', 'the commit failed');
  off();
  assert.deepEqual(streamed(heard, f.store, f.t.id), ['@beta first', '@beta second'], 'released to the stream, in order');
  const dir = f.store.dir;
  await f.store.close(); // before @beta's turn ends, whose next turn would take them
  const again = await new Store(dir).load();
  assert.deepEqual(waitingIn(again, f), ['@beta first', '@beta second'], 'the log holds both');
  await again.close();
  f.beta.release();
});

test('the person’s held messages behind a commit whose fsync fails: memory and the stream have them, the log doesn’t, and Retry agrees with it', async () => {
  const f = await busyRoom();
  const release = await f.hold([{ type: 'settings', data: { theme: 'system' } }]);
  const heard = [];
  const off = f.store.subscribe((ev) => heard.push(ev));
  f.rt.sendMessage(f.t.id, { text: '@beta first' });
  f.rt.sendMessage(f.t.id, { text: '@beta second' });
  assert.equal(await release(Object.assign(new Error('disk sync refused'), { code: 'EIO' })), 'EIO', 'the commit failed with the cause');
  off();
  assert.equal(f.store.writable, false, 'the failure closed the store to writes');
  assert.deepEqual(waitingIn(f.store, f), ['@beta first', '@beta second'], 'fail() released both onto memory, in order');
  assert.deepEqual(streamed(heard, f.store, f.t.id), ['@beta first', '@beta second'], 'and to the stream, so the page shows what memory holds');
  await f.store.reload(); // Retry installs what the disk holds
  assert.deepEqual(waitingIn(f.store, f), [], 'the log has neither: they were held when the write failed');
  f.beta.release();
  await settle(f.rt);
  await f.store.close();
});
