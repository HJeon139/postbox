// A deleted agent’s queued messages (#427): delete is immediate, and at once a
// message only for it is posted, waking no one and leaving the conversation’s hops alone (R2), and one for others too
// goes to them now.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseQueued } from '../server/message-queue.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** @alpha busy until released, with “@alpha later, please” queued for it. */
async function queuedForBusyAlpha() {
  const ctx = setup();
  const a = held();
  ctx.adapter.next.push(a.step);
  ctx.rt.sendMessage(ctx.t.id, { text: '@alpha a long job' });
  await sleep(5);
  assert.ok(ctx.rt.sendMessage(ctx.t.id, { text: '@alpha later, please' }).queued);
  return { ...ctx, a };
}
const posted = (store, threadId, text) => store.items(threadId).filter((i) => i.kind === 'user' && i.text === text);

test('at delete, a message only for that agent is posted once', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
});

test('at delete, a message for that agent and an idle one goes to the idle one now', async () => {
  const { store, rt, adapter, t, alpha, beta, a } = await queuedForBusyAlpha();
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta both of you' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  assert.ok(
    adapter.calls.some((x) => x.sessionId === beta.id && /both of you/.test(JSON.stringify(x.message))),
    '@beta got it',
  );
  assert.equal(
    store.state.threads[t.id].queue.some((q) => /both of you/.test(q.text)),
    false,
  );
});

test('R2: a release posts the text without a turn’s side effects: the conversation’s hops are not reset', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.putThread({ ...store.state.threads[t.id], hops: 3 });
  releaseQueued(rt, alpha.id);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
  assert.equal(store.state.threads[t.id].hops, 3);
  a.release();
  await settle(rt);
});

test('delete posts in queue order: M1 for @alpha and @beta, then M2 for @alpha alone, read M1 then M2 (nit)', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  store.emit('thread', { ...store.state.threads[t.id], queue: [] });
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta M1' }).queued);
  assert.ok(rt.sendMessage(t.id, { text: '@alpha M2' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  const order = store
    .items(t.id)
    .filter((i) => i.kind === 'user' && /M[12]$/.test(i.text))
    .map((i) => i.text.slice(-2));
  assert.deepEqual(order, ['M1', 'M2']);
});
