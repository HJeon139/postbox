// What #1418’s review found in the person’s message as an entry (#1404), each its reviewer’s repro: a resend with no
// @-mention, once the last speaker moved, is still the first try’s message (#1138); an agent the person removed the
// message for doesn’t read its words; an edit can’t change whom the message names; and a failed entry counts as given.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const said = (store, threadId, text) => store.items(threadId).filter((i) => i.kind === 'user' && i.text === text);

/** @alpha and @beta both busy in turns held open until released. */
async function bothBusy() {
  const f = setup();
  const a = held();
  const b = held();
  f.adapter.next.push(a.step, b.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha @beta start' });
  await sleep(5);
  return { ...f, a, b };
}

test('#1138 a resend with no @-mention is the first try’s message, though another agent spoke last since', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@alpha start' });
  await sleep(5);
  const first = rt.sendMessage(t.id, { text: 'no mention please', clientId: 'cl_x' });
  // The response is lost, and @beta starts a reply, which makes it the last speaker the resend would answer to.
  arrange.setThread(rt, t.id, { lastSpeaker: beta.id });
  const again = rt.sendMessage(t.id, { text: 'no mention please', clientId: 'cl_x' });
  assert.equal(again.item.id, first.item.id);
  assert.equal(said(store, t.id, 'no mention please').length, 1);
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), [], 'nothing for @beta');
  busy.release();
  await settle(rt);
});

test('an agent the person removed their message for reads that it was removed, not its words', async () => {
  const f = await bothBusy();
  const text = '@alpha @beta delete the prod table';
  const { queued } = f.rt.sendMessage(f.t.id, { text });
  f.rt.cancelQueued(f.t.id, queued.find((e) => e.sessionId === f.alpha.id).id);
  f.a.release();
  await sleep(20);
  f.rt.sendMessage(f.t.id, { text: '@alpha hello' });
  await sleep(20);
  const toAlpha = f.adapter.calls.filter((c) => c.sessionId === f.alpha.id).at(-1);
  const read = JSON.stringify(toAlpha.message);
  assert.ok(read.includes('@alpha hello'), 'the turn is the new message’s');
  assert.ok(!read.includes('delete the prod table'), read);
  assert.ok(read.includes('removed for you before you read it'), read);
  f.b.release();
  await settle(f.rt);
  const toBeta = f.adapter.calls.filter((c) => c.sessionId === f.beta.id).at(-1);
  assert.ok(JSON.stringify(toBeta.message).includes('delete the prod table'), '@beta still has it');
});

test('an edit that changes whom the message names is refused, and says what to do instead', async () => {
  const f = await bothBusy();
  const { item, queued } = f.rt.sendMessage(f.t.id, { text: '@alpha check the logs' });
  assert.throws(() => f.rt.editQueued(f.t.id, queued[0].id, '@beta check the logs'), {
    status: 409,
    message: 'Remove it and send a new message to change who it’s for.',
  });
  assert.equal(f.store.item(f.t.id, item.id).text, '@alpha check the logs');
  f.rt.editQueued(f.t.id, queued[0].id, '@alpha check the error logs');
  assert.equal(f.store.item(f.t.id, item.id).text, '@alpha check the error logs', 'the same names, other words');
  f.a.release();
  f.b.release();
  await settle(f.rt);
});

test('a message one agent’s entry failed on counts as given: Edit is refused', async () => {
  const f = await bothBusy();
  const { item, queued } = f.rt.sendMessage(f.t.id, { text: '@alpha @beta the plan' });
  // Lost on its resend too, the entry failed (#466): the agent was handed it.
  f.rt.delivery.patch(
    queued.find((e) => e.sessionId === f.alpha.id),
    { state: 'failed' },
  );
  const forBeta = queued.find((e) => e.sessionId === f.beta.id);
  assert.throws(() => f.rt.editQueued(f.t.id, forBeta.id, '@alpha @beta the new plan'), { status: 409, message: /@alpha already has this message/ });
  assert.equal(f.store.item(f.t.id, item.id).text, '@alpha @beta the plan');
  f.a.release();
  f.b.release();
  await settle(f.rt);
});
