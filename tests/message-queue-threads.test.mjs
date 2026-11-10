// The next turn after a busy one, when what waited for it is in more than one thread (#733): the thread queue of the
// turn's own thread folds into it, in arrival order, and nothing that waited is dropped when that turn can't start.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, settle, setup } from './side-threads-fixture.mjs';

/** The busy agent's turns after its first: the thread each ran in, and the texts its prompt held. */
const turnsAfterFirst = ({ adapter, beta, t }) =>
  adapter.calls
    .filter((c) => c.sessionId === beta.id)
    .slice(1)
    .map((c) => [c.thread === t.id ? 'conversation' : 'topic', (c.message.messages ?? [c.message]).map((m) => m.text)]);

/** The side-thread room with a topic in its conversation, and @beta busy in a turn held open. */
function busyWithTopic() {
  const f = setup();
  const root = f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  return { ...f, topic, busy };
}

test('a wake queued in a turn’s thread joins that turn when another thread’s message waits too', async () => {
  const f = busyWithTopic();
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in conversation.' });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in topic.' }, { threadId: f.topic });
  f.rt.agentWake(f.alpha.id, 'beta', 'Queued from alpha in conversation.');
  assert.equal(f.rt.turns.get(f.beta.id).pending.length, 2, 'two pending messages, in two threads');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['Pending in conversation.', 'Queued from alpha in conversation.']],
    ['topic', ['Pending in topic.']],
  ]);
});

test('after a failed reply, what was delivered while it ran goes, and a wake queued in its thread waits for the person (#1146)', async () => {
  const f = setup();
  const root = f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  let fail = () => {};
  const failing = new Promise((r) => {
    fail = r;
  });
  f.adapter.next.push(async () => {
    await failing;
    throw new Error('The reply broke off.');
  });
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in conversation.' });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in topic.' }, { threadId: topic });
  f.rt.agentWake(f.alpha.id, 'beta', 'Queued from alpha in conversation.');
  fail();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['Pending in conversation.']],
    ['topic', ['Pending in topic.']],
  ]);
  assert.deepEqual(
    f.store.state.threads[f.t.id].queue.map((q) => q.text),
    ['Queued from alpha in conversation.'],
  );
});

test('a queued wake stays behind a later pending message in its thread that can’t join', async () => {
  const f = busyWithTopic();
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending A.' });
  f.rt.deliver(f.beta.id, { kind: 'notice', text: 'Notice N.' });
  f.rt.agentWake(f.alpha.id, 'beta', 'Queued W.');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['Pending A.']],
    ['conversation', ['Notice N.']],
    ['conversation', ['Queued W.']],
  ]);
});

test('a summary turn takes nothing from its thread’s queue', async () => {
  const f = busyWithTopic();
  f.rt.deliver(f.beta.id, { kind: 'notice', text: 'Summarize the topic.' }, { summarizeTo: f.topic });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in topic.' }, { threadId: f.topic });
  f.rt.agentWake(f.alpha.id, 'beta', 'Queued W.');
  f.busy.release();
  await settle(f.rt);
  const turns = turnsAfterFirst(f);
  assert.deepEqual(turns[0], ['conversation', ['Summarize the topic.']], 'the summary turn is the notice alone');
  assert.deepEqual(turns.at(-1), ['conversation', ['Queued W.']], 'the wake has a turn of its own');
});

test('Send now, then messages in two threads during the exit: a wake queued in the conversation joins its turn', async (t) => {
  const f = busyWithTopic();
  // One clock reading for all of it, as when the wake and the person's message land in the same millisecond: their
  // order then comes from when each arrived, not from the clock (#733, the integrator's read of #1045).
  t.mock.method(Date, 'now', () => 1_000_000);
  f.rt.agentWake(f.alpha.id, 'beta', 'Queued W in conversation.');
  const q = f.rt.sendMessage(f.topic, { text: '@beta topic P' });
  f.rt.sendQueuedNow(f.topic, q.queued.id);
  assert.ok(f.rt.exiting.has(f.beta.id), 'the stopped turn is exiting');
  f.rt.sendMessage(f.t.id, { text: '@beta conversation P' });
  f.rt.sendMessage(f.topic, { text: '@beta topic Q' });
  f.busy.release();
  await settle(f.rt);
  const turns = turnsAfterFirst(f);
  assert.deepEqual(
    turns.map(([where, texts]) => [where, texts.length]),
    [
      ['topic', 1],
      ['conversation', 2],
      ['topic', 1],
    ],
    'three turns, not four',
  );
  // In arrival order: the wake came first. The person's message comes as a pointer to the room summary that gave it.
  assert.equal(turns[1][1][0], 'Queued W in conversation.');
  assert.match(turns[1][1][1], /@beta conversation P/);
});

test('writes close as the turn ends: what waited in two threads is delivered once they reopen, not dropped', async () => {
  const f = busyWithTopic();
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in conversation.' });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in topic.' }, { threadId: f.topic });
  const takePending = f.rt.takePending.bind(f.rt);
  f.rt.takePending = (se, turn, drain) => {
    if (se.id === f.beta.id) f.store.fail(Object.assign(new Error('disk sync refused'), { code: 'EIO' }));
    return takePending(se, turn, drain);
  };
  f.busy.release();
  await settle(f.rt);
  assert.equal(f.rt.turns.has(f.beta.id), false, 'no turn could start');
  f.rt.takePending = takePending;
  f.store.writable = true; // writes reopen, as Retry does, and the status listeners run what waited
  f.store.cause = null;
  f.store.tellStatus();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [
    ['conversation', ['Pending in conversation.']],
    ['topic', ['Pending in topic.']],
  ]);
});

test('Postbox shutting down as the turn ends: what waited in another thread is logged, not dropped without a word', async (t) => {
  const f = busyWithTopic();
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in conversation.' });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in topic.' }, { threadId: f.topic });
  const warn = t.mock.method(console, 'warn', () => {});
  f.rt.closing = true; // what stopTurns sets first; a turn it didn't stop, such as a remote one, still ends
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [], 'no turn starts while shutting down');
  const said = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    said.some((s) => s.includes('@beta') && s.includes('2 waiting deliveries') && s.includes('agent')),
    `the drop is logged, the first group counted with the rest: ${JSON.stringify(said)}`,
  );
});

test('Postbox shutting down as the turn ends, with one delivery waiting: that one is logged too', async (t) => {
  const f = busyWithTopic();
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@gamma', text: 'Pending in conversation.' });
  const warn = t.mock.method(console, 'warn', () => {});
  f.rt.closing = true;
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(turnsAfterFirst(f), [], 'no turn starts while shutting down');
  const said = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    said.some((s) => s.includes('@beta') && s.includes('1 waiting delivery') && s.includes('agent')),
    `the drop is logged: ${JSON.stringify(said)}`,
  );
});
