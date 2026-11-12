// Starting a conversation while a commit is held (#796’s class): the new thread is held behind the commit, so it isn’t
// in the published state yet. POST /api/threads sends what createThread returns, and createThread returned the
// published thread, undefined there, so the route answered with nothing; with agents, ensureSession looked for the
// thread in the published state too and refused it as deleted. Both read the thread as written, from store.pending.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchThread } from '../server/room-chain-limit.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

/** A runtime on a store whose next commit is held, with fn run while it is. */
async function whileHeld(fn) {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync; // the commit is in flight: emits from now on are held behind it
  let result;
  try {
    result = fn(env);
  } finally {
    h.release();
    await commit;
    await h.store.flush();
  }
  return { env, result, store: h.store };
}

test('starting a conversation with no agents while a commit is held returns the new thread for the route to send', async () => {
  const { result, store } = await whileHeld(({ rt }) => rt.createThread({ projectId: 'p1', title: 'Held' }));
  assert.ok(result, 'createThread returned the thread');
  assert.equal(result.title, 'Held');
  assert.equal(store.state.threads[result.id]?.title, 'Held', 'and it was written');
  await store.close();
});

test('starting a conversation with an agent while a commit is held joins the agent and returns the thread with it', async () => {
  const { env, result, store } = await whileHeld(({ rt }) => {
    const p = rt.personaByHandle('researcher');
    return rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
  });
  assert.ok(result, 'createThread returned the thread');
  assert.equal(result.members.length, 1, 'with its agent as a member');
  assert.deepEqual(
    env.rt.sessionsIn(result.id).map((se) => se.handle),
    ['researcher'],
    'the agent’s session was written',
  );
  await store.close();
});

// PATCH /api/threads/:id sends what patchThread returns. A conversation deleted while a commit is held is still in the
// published state, so it passed rt.thread, but updateThread found no thread to write and returned undefined.
for (const [what, body] of [
  ['renaming', { title: 'Renamed' }],
  ['setting the chain limit of', { chainLimit: 5 }],
]) {
  test(`${what} a conversation deleted behind a held commit is refused as deleted, not answered with nothing`, async () => {
    const { result, store } = await whileHeld(({ rt, t }) => {
      rt.deleteThread(t.id);
      try {
        return patchThread(rt, t.id, body);
      } catch (e) {
        return e;
      }
    });
    assert.equal(result?.status, 404, `refused: ${result?.message ?? JSON.stringify(result)}`);
    await store.close();
  });
}
