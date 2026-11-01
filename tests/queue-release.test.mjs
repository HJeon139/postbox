// A deleted agent’s queued messages (#427, #597; design-597-release-1): the queue is untouched at delete, so Undo is
// exact (R1); the drain gives nothing to an agent being deleted; at the purge, a message only for it is posted once,
// waking no one and leaving the conversation’s hops alone (R2), and one for others too goes to them now.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { releaseQueued } from '../server/message-queue.mjs';
import { Runtime } from '../server/runtime.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

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

test('R1: delete, then Undo: the message is still queued, and not in the transcript (the integrator’s repro)', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  rt.undoDelete(alpha.id);
  assert.deepEqual(
    store.state.threads[t.id].queue.map((q) => q.text),
    ['@alpha later, please'],
  );
  assert.equal(posted(store, t.id, '@alpha later, please').length, 0);
  a.release();
  await settle(rt);
});

test('R1: while the agent is being deleted, a drain delivers nothing to it and posts nothing', async () => {
  const { store, rt, adapter, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.drainQueue(t.id);
  await settle(rt);
  assert.equal(
    adapter.calls.some((x) => x.sessionId === alpha.id && /later, please/.test(x.message.text ?? '')),
    false,
  );
  assert.equal(store.state.threads[t.id].queue.length, 1, 'still queued for the Undo window');
  assert.equal(posted(store, t.id, '@alpha later, please').length, 0);
});

test('R2: at the purge, a message only for that agent is posted once, and the conversation’s hops stay as they were', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.putThread({ ...store.state.threads[t.id], hops: 3 });
  rt.purgeSession(alpha.id);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
  assert.equal(store.state.threads[t.id].hops, 3);
});

test('at the purge, a message for that agent and an idle one goes to the idle one now', async () => {
  const { store, rt, adapter, t, alpha, beta, a } = await queuedForBusyAlpha();
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta both of you' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  rt.purgeSession(alpha.id);
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

test('a restart inside the Undo window keeps the message queued until the rearmed purge, then posts it once', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  const again = new Runtime({ store, adapters: new AdapterRegistry().register(new ScriptedAdapter()), corpus: rt.corpus, config: rt.config });
  again.rearmDeletions();
  assert.ok(again.timers.has(`del:${alpha.id}`), 'the purge is armed again');
  assert.equal(store.state.threads[t.id].queue.length, 1);
  clearTimeout(again.timers.get(`del:${alpha.id}`));
  again.purgeSession(alpha.id);
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
  assert.deepEqual(store.state.threads[t.id].queue, []);
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
