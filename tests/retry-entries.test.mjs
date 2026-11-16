// Retry runs on entries (#1429’s 4c-b; designs/architecture/services.md, Delivery’s retry): the failed turn’s entries
// reopen as a resend, and the turn that takes them is built from them, so its input marks each as sent again; nothing
// sends the asked message again. A Retry doesn’t hand over again what the failed reply already handed over (#485).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** A failed reply of beta’s to the person’s message, and beta’s turns. */
async function failedForBeta(f, reply = 'Partial.') {
  f.adapter.next.push(async (c) => {
    c.text(reply);
    throw new Error('API 500');
  });
  f.rt.sendMessage(f.t.id, { text: '@beta check the totals' });
  await settle(f.rt);
  return f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
}
const turnsOf = (f, se) => f.adapter.calls.filter((c) => c.sessionId === se.id);

test('#1429 Retry reopens the failed turn’s entries as a resend, and its turn is given them marked as sent again', async () => {
  const f = setup();
  const failed = await failedForBeta(f);
  await f.rt.retry(f.t.id, failed.id);
  await settle(f.rt);
  const again = turnsOf(f, f.beta).at(-1);
  assert.equal(again.message.kind, 'input');
  assert.match(again.message.text, /The person, \d\d:\d\d UTC, sent again in case it didn’t reach you: @beta check the totals/);
  const [entry] = f.rt.delivery.inbox(f.beta.id);
  assert.deepEqual([entry.state, entry.resend], ['delivered', true]);
  assert.equal(f.store.item(f.t.id, failed.id).status, 'retried');
});

test('#1429 #485 Retry of a failed reply that handed work over doesn’t hand it over again', async () => {
  const f = setup();
  const failed = await failedForBeta(f, '@alpha the totals are in.');
  assert.equal(turnsOf(f, f.alpha).length, 1, 'alpha heard the failed reply’s hand-off');
  f.adapter.next.push(async (c) => c.text('@alpha the totals are in, all of them.'));
  await f.rt.retry(f.t.id, failed.id);
  await settle(f.rt);
  assert.equal(turnsOf(f, f.alpha).length, 1, 'the retry woke alpha no second time');
});
