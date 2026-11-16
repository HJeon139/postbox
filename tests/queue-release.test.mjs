// A deleted agent’s queued messages (#427): delete is immediate. The person’s message is posted when it’s sent (#1404),
// so one only for it stays in the conversation once, and reaches no one; one for others too goes to them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
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
  assert.deepEqual(arrange.personWaiting(rt, t.id), [], 'nothing waits for the deleted agent');
  assert.equal(posted(store, t.id, '@alpha later, please').length, 1);
});

test('at delete, a message for that agent and an idle one goes to the idle one now', async () => {
  const { rt, adapter, t, alpha, beta, a } = await queuedForBusyAlpha();
  assert.ok(rt.sendMessage(t.id, { text: '@alpha @beta both of you' }).queued);
  rt.deleteSession(alpha.id);
  a.release();
  await settle(rt);
  assert.ok(
    adapter.calls.some((x) => x.sessionId === beta.id && /both of you/.test(JSON.stringify(x.message))),
    '@beta got it',
  );
  assert.deepEqual(arrange.personWaiting(rt, t.id), []);
});

test('delete posts in queue order: M1 for @alpha and @beta, then M2 for @alpha alone, read M1 then M2 (nit)', async () => {
  const { store, rt, t, alpha, a } = await queuedForBusyAlpha();
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
