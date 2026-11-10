// What waits for an agent whose last reply failed (#1146, the person’s choice): nothing goes, neither the person’s
// messages nor other agents’ wakes, until the person acts. A message of theirs takes what waited, in the order it was
// sent, with theirs last; Retry’s turn goes first, and its end hands on the rest in that order.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { dismissFailed } from '../server/card-needs.mjs';
import { Runtime } from '../server/runtime.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

const M1 = '@beta M1: the 1908 edition differs.';
const SENT = ['@beta P1', 'W1: which editions?', M1, '@beta P2'];

/**
 * @beta busy in a turn that fails once released. While it runs, four messages queue for it, in this order: P1, the
 * person’s; W1, @alpha’s wake_agent; M1, @alpha’s reply @-mentioning it; P2, the person’s. Then its turn fails.
 */
async function failedWithFourWaiting() {
  const ctx = setup();
  const { store, rt, adapter, t, alpha, beta } = ctx;
  const failing = held();
  adapter.next.push(async (c) => {
    await failing.step(c);
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@beta a long job' });
  let alphaDone = () => {};
  const alphaHeld = new Promise((r) => {
    alphaDone = r;
  });
  adapter.next.push(async (c) => {
    c.text(M1);
    await alphaHeld;
  });
  rt.sendMessage(t.id, { text: '@alpha look it up' });
  await sleep(5);
  assert.ok(rt.sendMessage(t.id, { text: '@beta P1' }).queued);
  rt.agentWake(alpha.id, 'beta', 'W1: which editions?', { fromTurnId: rt.turns.get(alpha.id).id });
  alphaDone();
  await sleep(20);
  assert.ok(rt.sendMessage(t.id, { text: '@beta P2' }).queued);
  const queue = () => store.state.threads[t.id].queue;
  assert.deepEqual(
    queue().map((q) => q.text),
    SENT,
  );
  failing.release();
  await sleep(20);
  const betaCalls = () => adapter.calls.filter((x) => x.sessionId === beta.id);
  return { ...ctx, queue, betaCalls };
}

// Which of the sent messages each part of a turn's message is: a mention the turn's room summary already gave it comes
// as a pointer quoting it (#484, #504), as M1 does to the retried turn.
const texts = (message) => (message.messages ?? [message]).map((m) => [...SENT, '@beta P3'].find((x) => m.text.includes(x)) ?? m.text);

test('#1146: after a failed turn nothing waiting goes, and the person’s next message takes it all, in send order, theirs last', async () => {
  const { rt, t, queue, betaCalls } = await failedWithFourWaiting();
  assert.equal(betaCalls().length, 1, 'a turn started for @beta after its failure');
  assert.equal(queue().length, 4);
  const sent = rt.sendMessage(t.id, { text: '@beta P3' });
  await sleep(20);
  assert.equal(sent.queued, undefined, 'the page would say it waits for the agent to finish');
  assert.equal(betaCalls().length, 2);
  assert.deepEqual(texts(betaCalls()[1].message), [...SENT, '@beta P3']);
  assert.deepEqual(queue(), []);
  await settle(rt);
});

test('#1146: Retry runs first, and its turn’s end hands on what waited, in send order', async () => {
  const { store, rt, adapter, t, beta, queue, betaCalls } = await failedWithFourWaiting();
  assert.equal(betaCalls().length, 1, 'a turn started for @beta after its failure');
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id && i.status === 'failed');
  const retrying = held();
  adapter.next.push(retrying.step);
  await rt.retry(t.id, failed.id);
  await sleep(10);
  assert.equal(betaCalls().length, 2);
  assert.equal(betaCalls()[1].message.retry, true);
  assert.equal(queue().length, 4, 'what waited went with the retried turn');
  retrying.release();
  await sleep(20);
  assert.equal(betaCalls().length, 3);
  assert.deepEqual(texts(betaCalls()[2].message), SENT);
  assert.deepEqual(queue(), []);
  await settle(rt);
});

test('#1146: Dismiss ends the hold, and what waited goes in send order', async () => {
  const { store, rt, t, beta, queue, betaCalls } = await failedWithFourWaiting();
  const failed = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === beta.id && i.status === 'failed');
  dismissFailed(rt, t.id, failed.id);
  await sleep(20);
  assert.equal(betaCalls().length, 2, 'what waited stayed held after Dismiss');
  assert.deepEqual(texts(betaCalls()[1].message), SENT);
  assert.deepEqual(queue(), []);
  await settle(rt);
});

test('#1146: the person’s message releases the failure: its own thread’s queue goes first, another thread’s after that turn', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  const failing = held();
  adapter.next.push(async (c) => {
    await failing.step(c);
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@beta a long job' });
  await sleep(5);
  assert.ok(rt.sendMessage(topic, { text: '@beta T1' }).queued);
  failing.release();
  await sleep(20);
  assert.deepEqual(
    store.state.threads[topic].queue.map((q) => q.text),
    ['@beta T1'],
  );
  rt.sendMessage(t.id, { text: '@beta P3' });
  await settle(rt);
  const turns = adapter.calls.filter((x) => x.sessionId === beta.id).slice(1);
  assert.deepEqual(
    turns.map((x) => [x.thread === topic ? 'topic' : 'conversation', x.message.text]),
    [
      ['conversation', '@beta P3'],
      ['topic', '@beta T1'],
    ],
  );
});

test('#1146: a wake waiting in another thread doesn’t hold the person’s message again once its turn ends', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  const failing = held();
  adapter.next.push(async (c) => {
    await failing.step(c);
    throw new Error('API 500');
  });
  rt.sendMessage(t.id, { text: '@beta a long job' });
  await sleep(5);
  rt.agentWake(alpha.id, 'beta', 'TW1: a question in the topic.', { replyIn: topic });
  failing.release();
  await sleep(20);
  assert.deepEqual(
    store.state.threads[topic].queue.map((q) => q.text),
    ['TW1: a question in the topic.'],
    'the wake is held after the failure',
  );
  rt.sendMessage(t.id, { text: '@beta P3' });
  await settle(rt);
  const turns = adapter.calls.filter((x) => x.sessionId === beta.id).slice(1);
  assert.deepEqual(
    turns.map((x) => [x.thread === topic ? 'topic' : 'conversation', JSON.stringify(x.message).includes('TW1') ? 'TW1' : x.message.text]),
    [
      ['conversation', '@beta P3'],
      ['topic', 'TW1'],
    ],
  );
  assert.deepEqual(store.state.threads[topic].queue ?? [], [], 'nothing left waiting');
});

test('#1146: a wake sent to the agent after its failure waits in the queue with the rest', async () => {
  const { rt, alpha, queue, betaCalls } = await failedWithFourWaiting();
  const r = rt.agentWake(alpha.id, 'beta', 'W2: one more thing.');
  await sleep(20);
  assert.equal(r.ok, true);
  assert.match(r.message, /failed/);
  assert.equal(betaCalls().length, 1, 'the wake started a turn for @beta');
  assert.deepEqual(
    queue().map((q) => q.text),
    [...SENT, 'W2: one more thing.'],
  );
  await settle(rt);
});

test('#1146: another agent’s turn ending, or a restart, sends nothing that waits for the failed agent', async () => {
  const { store, rt, adapter, t, alpha, queue, betaCalls } = await failedWithFourWaiting();
  rt.sendMessage(t.id, { text: '@alpha and another' });
  await sleep(20);
  assert.ok(adapter.calls.some((x) => x.sessionId === alpha.id && x.message.text === '@alpha and another'));
  assert.equal(rt.turns.has(alpha.id), false);
  assert.equal(betaCalls().length, 1, 'another agent’s turn end released @beta’s');
  assert.equal(queue().length, 4);
  rt.drainAll();
  await sleep(20);
  assert.equal(betaCalls().length, 1, 'drainAll released @beta’s');
  // The server stops with them still queued; the new one sends what can go once it listens (index.mjs calls drainAll).
  const after = new ScriptedAdapter();
  const again = new Runtime({ store, adapters: new AdapterRegistry().register(after), corpus: rt.corpus, config: rt.config });
  again.drainAll();
  await sleep(20);
  assert.deepEqual(after.calls, [], 'a restart released @beta’s');
  assert.equal(queue().length, 4);
  await settle(rt);
});
