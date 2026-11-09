// The first turn after a stopped turn exits (#1040): after a plain Stop, the agents’ wakes queued in its thread join
// it, in arrival order, as at a turn’s normal end (#733); after Send now, it sends only the person’s message, and the
// wake runs in the next turn. A held message that can’t join keeps the queue behind it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** @beta’s turns after its first: the thread each ran in, and the texts its prompt held. */
const turnsAfterFirst = ({ adapter, beta, t }) =>
  adapter.calls
    .filter((c) => c.sessionId === beta.id)
    .slice(1)
    .map((c) => [c.thread === t.id ? 'conversation' : 'topic', (c.message.messages ?? [c.message]).map((m) => m.text)]);

/** The side-thread room with @beta busy in a turn held open, then stopped by the person: its process is exiting. */
async function stoppedBeta() {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5); // the turn reaches its adapter, so its first call is recorded before the Stop
  f.rt.stop(f.beta.id);
  assert.ok(f.rt.exiting.has(f.beta.id), 'the stopped turn is exiting');
  return { ...f, busy };
}

test('after a Stop, a wake queued in the thread joins the first turn there with the person’s message written during the exit', async () => {
  const f = await stoppedBeta();
  f.rt.sendMessage(f.t.id, { text: '@beta after the stop' });
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [['conversation', ['@beta after the stop', 'Wake W from alpha.']]]);
});

test('after a Stop, a wake that arrived before the person’s message leads the first turn, by arrival', async (t) => {
  const f = await stoppedBeta();
  // One clock reading for both, so their order comes from when each arrived, not from the clock (#733).
  t.mock.method(Date, 'now', () => 1_000_000);
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  f.rt.sendMessage(f.t.id, { text: '@beta after the stop' });
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [['conversation', ['Wake W from alpha.', '@beta after the stop']]]);
});

test('after a Stop with nothing written during the exit, a wake queued meanwhile runs as the next turn', async () => {
  const f = await stoppedBeta();
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [['conversation', ['Wake W from alpha.']]]);
});

test('after a Stop, the person’s message queued before it and a wake queued during the exit run as one turn', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.rt.sendMessage(f.t.id, { text: '@beta queued before the stop' });
  f.rt.stop(f.beta.id);
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [['conversation', ['@beta queued before the stop', 'Wake W from alpha.']]]);
});

test('a Send now turn sends only the person’s message; the wake runs in the next turn', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  const q = f.rt.sendMessage(f.t.id, { text: '@beta change of plan' });
  f.rt.sendQueuedNow(f.t.id, q.queued.id);
  assert.ok(f.rt.exiting.has(f.beta.id), 'the stopped turn is exiting');
  busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['@beta change of plan']],
    ['conversation', ['Wake W from alpha.']],
  ]);
});

test('Send now pressed while a plain Stop is still exiting sends only the person’s message; the wake runs next', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  const q = f.rt.sendMessage(f.t.id, { text: '@beta change of plan' });
  f.rt.stop(f.beta.id); // a plain Stop: the turn leaves turns, so Send now’s own stop finds nothing to stop
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  f.rt.sendQueuedNow(f.t.id, q.queued.id);
  assert.ok(f.rt.exiting.has(f.beta.id), 'the stopped turn is still exiting');
  busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['@beta change of plan']],
    ['conversation', ['Wake W from alpha.']],
  ]);
});

test('Send now during a plain Stop’s exit leaves the person’s other queued message for the next turn too', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  const q = f.rt.sendMessage(f.t.id, { text: '@beta change of plan' });
  f.rt.sendMessage(f.t.id, { text: '@beta and later this' });
  f.rt.stop(f.beta.id);
  f.rt.sendQueuedNow(f.t.id, q.queued.id);
  busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f).slice(0, 1), [['conversation', ['@beta change of plan']]]);
  assert.ok(
    turnsAfterFirst(f)
      .slice(1)
      .flatMap(([, texts]) => texts)
      .includes('@beta and later this'),
    'the other queued message runs after the Send now turn',
  );
});

test('after a Stop, a held notice behind the person’s message keeps the queued wake behind it', async () => {
  const f = await stoppedBeta();
  f.rt.sendMessage(f.t.id, { text: '@beta after the stop' });
  f.rt.deliver(f.beta.id, { kind: 'notice', text: 'Notice N.' });
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['@beta after the stop']],
    ['conversation', ['Notice N.']],
    ['conversation', ['Wake W from alpha.']],
  ]);
});

test('after a Stop, a slash command run during the exit is its own turn, and the queued wake runs after it', async () => {
  const f = await stoppedBeta();
  f.rt.runAgentCommand(f.t.id, { sessionId: f.beta.id, text: '/review now' });
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['/review now']],
    ['conversation', ['Wake W from alpha.']],
  ]);
});

test('after writes close and stop the turn, the first turn once they reopen takes the wake queued in its thread too', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending from gamma.' });
  f.rt.agentWake(f.alpha.id, 'beta', 'Wake W from alpha.');
  // Writes close: the outage stops the running turn, and what waited behind it is held for its exit (store-outage.mjs).
  f.store.fail(Object.assign(new Error('disk sync refused'), { code: 'EIO' }));
  await settle(f.rt);
  assert.ok(f.rt.exiting.has(f.beta.id), 'the outage stopped the turn, which is exiting');
  busy.release();
  await settle(f.rt);
  f.store.writable = true; // writes reopen, as Retry does, and the status listeners run what waited
  f.store.cause = null;
  f.store.tellStatus();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [['conversation', ['Pending from gamma.', 'Wake W from alpha.']]]);
});
