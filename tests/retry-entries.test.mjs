// Retry runs on entries (#1429’s 4c-b; designs/architecture/services.md, Delivery’s retry): the failed turn’s entries
// reopen as a resend, and the turn that takes them is built from them, so its input marks each as sent again; nothing
// sends the asked message again. A Retry doesn’t hand over again what the failed reply already handed over (#485), and
// that mark rides on the reopened entries, so whichever turn takes them has it and no other turn does. An app’s event
// keeps what the app sent while its failed turn can still be retried (#1425).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

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

test('#1429 #485 a Retry’s turn started by Send now doesn’t hand work over again, and the next turn hands over what’s new', async () => {
  const f = setup();
  const failed = await failedForBeta(f, '@alpha the totals are in.');
  assert.equal(turnsOf(f, f.alpha).length, 1, 'alpha heard the failed reply’s hand-off');
  // The person’s next message starts beta in a turn held open.
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta something else first' });
  await sleep(5);
  // Retry while beta is busy: its entry waits, and the person sends it now.
  await f.rt.retry(f.t.id, failed.id);
  const [reopened] = f.rt.delivery.waiting(f.beta.id);
  f.adapter.next.push(async (c) => c.text('@alpha the totals are in, all of them.'));
  f.rt.sendQueuedNow(f.t.id, reopened.id);
  busy.release();
  await settle(f.rt);
  assert.equal(turnsOf(f, f.alpha).length, 1, 'the retry woke alpha no second time');
  // A later turn of beta’s isn’t the retry: its hand-off to alpha arrives.
  f.adapter.next.push(async (c) => c.text('@alpha a brand new question.'));
  f.rt.sendMessage(f.t.id, { text: '@beta ask alpha something new' });
  await settle(f.rt);
  assert.match(JSON.stringify(turnsOf(f, f.alpha).at(-1).message), /a brand new question/);
});

test('#1429 #1425 Retry of an app event’s failed turn gives it what the app sent again', async () => {
  const f = setup();
  f.rt.toolsFor(f.beta.id).show_app({ id: 'lab', title: 'Lab', code: '<p>x</p>', permissions: [] });
  f.adapter.next.push(async () => {
    throw new Error('API 500');
  });
  f.rt.appEvent('lab', 'try', { secret: 'a value only the turn reads' });
  await settle(f.rt);
  const failed = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  await f.rt.retry(f.t.id, failed.id);
  await settle(f.rt);
  const again = turnsOf(f, f.beta).at(-1).message;
  assert.equal(again.kind, 'event', JSON.stringify(again));
  assert.equal(again.event.values.secret, 'a value only the turn reads');
});

test('#1541 a wake whose turn failed, retried by the person, goes back once: the reopened mention is what it reads', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('@beta which file holds the changelog?'));
  f.adapter.next.push(async () => {
    throw new Error('API 500');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha find out where the changelog goes' });
  for (let i = 0; i < 3; i++) await settle(f.rt);
  const failed = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.handle === 'beta' && i.status === 'failed');
  f.adapter.next.push(async (c) => c.text('It’s CHANGELOG.md, at the root.'));
  await f.rt.retry(f.t.id, failed.id);
  // The answer goes back to alpha, whose unscripted turn reacts to it and ends the exchange.
  for (let i = 0; i < 5; i++) await settle(f.rt);
  assert.deepEqual(
    f.adapter.calls.map((c) => c.handle),
    ['alpha', 'beta', 'beta', 'alpha'],
  );
  const answer = f.store.items(f.t.id).find((i) => i.text === 'It’s CHANGELOG.md, at the root.');
  assert.deepEqual(answer.wentBack, ['alpha']);
});
