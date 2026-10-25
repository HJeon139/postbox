// Queued wakes become one turn per agent and thread, with stale work removed when delivery starts (#374).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { batchPending } from '../server/message-queue.mjs';
import { combineMessages } from '../server/queue-batch.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

test('three queued wakes from different agents become one turn with each sender and time', async () => {
  const { rt, store, adapter, t, alpha, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const delta = rt.ensureSession(t.id, rt.createPersona({ handle: 'delta' }).id);
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  for (const [sender, text] of [
    [alpha, 'First'],
    [gamma, 'Second'],
    [delta, 'Third'],
  ])
    rt.agentWake(sender.id, 'beta', text);
  const queue = store.state.threads[t.id].queue.map((q, index) => ({ ...q, at: (index + 1) * 1000 }));
  rt.putThread({ ...store.state.threads[t.id], queue });
  assert.equal(queue.length, 3, 'each queued wake stays visible until delivery');
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2, 'one initial turn and one batch');
  assert.deepEqual(
    calls[1].message.messages.map((message) => [message.from, message.text, message.at]),
    [
      ['@alpha', 'First', 1000],
      ['@gamma', 'Second', 2000],
      ['@delta', 'Third', 3000],
    ],
  );
  const prompt = formatMessage(calls[1].message);
  assert.match(prompt, /1970-01-01T00:00:01.000Z/);
  assert.match(prompt, /@alpha[\s\S]*@gamma[\s\S]*@delta/);
  assert.deepEqual(store.state.threads[t.id].queue, []);
});

test('a later message from a waker supersedes its old queued wake', async () => {
  const { rt, store, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Review the old revision.');
  rt.agentWake(alpha.id, 'beta', 'Review the new revision.');
  assert.equal(store.state.threads[t.id].queue.length, 2);
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.text, 'Review the new revision.');
});

test('a waker’s unaddressed later post replaces a queued wake and reaches its target exactly once', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Please check it.');
  rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'I already resolved it.', status: 'done' });
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2, 'one initial turn and one turn with the newer context');
  assert.equal(calls[1].message.text, 'I already resolved it.');
});

test('queued user messages and agent wakes share one turn without losing user transcript items', async () => {
  const { rt, store, adapter, t, alpha, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'The first point.');
  rt.sendMessage(t.id, { text: '@beta include the second point.' });
  rt.agentWake(gamma.id, 'beta', 'The third point.');
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].message.messages.map((message) => message.kind),
    ['agent', 'user', 'agent'],
  );
  assert.equal(store.items(t.id).filter((item) => item.kind === 'user' && item.text === '@beta include the second point.').length, 1);
});

test('Cancel removes only its queued wake and Send now delivers only the selected item first', async () => {
  const { rt, store, adapter, t, alpha, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Cancel this.');
  rt.agentWake(gamma.id, 'beta', 'Send this now.');
  rt.agentWake(alpha.id, 'beta', 'Keep this queued.');
  const [cancel, send] = store.state.threads[t.id].queue;
  rt.cancelQueued(t.id, cancel.id);
  rt.sendQueuedNow(t.id, send.id);
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls[1].message.text, 'Send this now.');
  assert.equal(calls[2].message.text, 'Keep this queued.');
  assert.ok(!calls.some((call) => call.message.text === 'Cancel this.'));
});

test('a waker finishing the same turn does not supersede its own queued handoff', async () => {
  const { rt, store, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Please review.', { fromTurnId: 'source-turn' });
  rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', turnId: 'source-turn', text: 'I asked for review.', status: 'done' });
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((call) => call.sessionId === beta.id)[1].message.text, 'Please review.');
  assert.deepEqual(store.state.threads[t.id].queue, []);
});

test('direct pending messages and a queued wake are delivered together', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.deliver(beta.id, { kind: 'agent', from: '@gamma', text: 'Pending one.' });
  rt.deliver(beta.id, { kind: 'agent', from: '@delta', text: 'Pending two.' });
  rt.agentWake(alpha.id, 'beta', 'Queued third.');
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].message.messages.map((message) => message.text),
    ['Pending one.', 'Pending two.', 'Queued third.'],
  );
});

test('a batch never combines messages from the conversation and a topic thread', async () => {
  const { rt, adapter, t, alpha, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'In the conversation.');
  rt.agentWake(gamma.id, 'beta', 'In the topic.', { replyIn: topic });
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.deepEqual(
    calls.slice(1).map((call) => [call.thread, call.message.text]),
    [
      [t.id, 'In the conversation.'],
      [topic, 'In the topic.'],
    ],
  );
});

test('a post in another thread does not supersede a queued wake in the conversation', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Still needed.');
  rt.addItem(topic, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'Different topic.', status: 'done' });
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((call) => call.sessionId === beta.id)[1].message.text, 'Still needed.');
});

test('refreshing a wake does not strand a queued message addressed to several agents', async () => {
  const { rt, store, adapter, t, alpha } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Obsolete request.');
  rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'Already resolved.', status: 'done' });
  rt.sendMessage(t.id, { text: '@alpha @beta the shared next task.' });
  busy.release();
  await settle(rt);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  const delivered = adapter.calls.flatMap((call) => call.message.messages ?? [call.message]);
  assert.equal(delivered.filter((message) => message.text === '@alpha @beta the shared next task.').length, 2);
  assert.equal(delivered.filter((message) => message.text === 'Already resolved.').length, 1);
});

test('overlapping recipient lists give each agent one batch and post shared user messages once', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.sendMessage(t.id, { text: '@beta first' });
  rt.sendMessage(t.id, { text: '@alpha @beta shared' });
  rt.sendMessage(t.id, { text: '@beta last' });
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].message.messages.map((message) => message.text),
    ['@beta first', '@alpha @beta shared', '@beta last'],
  );
  assert.equal(adapter.calls.filter((call) => call.handle === 'alpha').length, 1);
  assert.equal(store.items(t.id).filter((item) => item.kind === 'user' && item.text === '@alpha @beta shared').length, 1);
});

test('an empty streaming placeholder does not supersede a queued wake', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Still needs review.', { fromTurnId: 'old-turn' });
  rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', turnId: 'new-turn', text: '', status: 'streaming' });
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((call) => call.sessionId === beta.id)[1].message.text, 'Still needs review.');
});

test('stopping a turn preserves each agent’s message from a mixed pending batch', async () => {
  const { rt, store, adapter, t, beta } = setup();
  const first = held();
  const second = held();
  let started;
  const nextStarted = new Promise((resolve) => {
    started = resolve;
  });
  adapter.next.push(first.step, async (ctx) => {
    started();
    await second.step(ctx);
  });
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.deliver(beta.id, { kind: 'notice', text: 'A separate event.' });
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'Alpha’s request.' });
  rt.deliver(beta.id, { kind: 'user', text: 'The person’s request.' });
  rt.deliver(beta.id, { kind: 'agent', from: '@gamma', text: 'Gamma’s request.' });
  first.release();
  await nextStarted;
  rt.stop(beta.id);
  second.release();
  await settle(rt);
  const context = store.state.sessions[beta.id].context.join('\n');
  assert.match(context, /@alpha’s message came while your turn was stopped: “Alpha’s request\.”/);
  assert.match(context, /@gamma’s message came while your turn was stopped: “Gamma’s request\.”/);
});

test('a pending batch is reconsidered when a newer message supersedes one of its children', () => {
  const { rt, t } = setup();
  const messages = [
    ['alpha', 'old', 'Old request.'],
    ['gamma', 'other', 'Independent request.'],
    ['alpha', 'new', 'Current request.'],
  ].map(([handle, turnId, text]) => {
    const item = rt.addItem(t.id, { kind: 'agent', handle, turnId, text, status: 'done' });
    return { kind: 'agent', from: `@${handle}`, text, itemId: item.id, at: item.at };
  });
  const pending = [{ message: combineMessages(messages.slice(0, 2)) }, { message: messages[2] }];
  const groups = batchPending(rt, pending, t.id);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].message.messages.map((message) => message.text),
    ['Independent request.', 'Current request.'],
  );
});

test('a newer unaddressed post replaces a directly pending wake exactly once', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  const old = rt.addItem(t.id, { kind: 'agent', handle: 'alpha', turnId: 'old', text: 'Please review.' });
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: old.text, itemId: old.id, at: old.at });
  const newer = rt.addItem(t.id, {
    kind: 'agent',
    sessionId: alpha.id,
    handle: 'alpha',
    turnId: 'new',
    text: 'New context without a mention.',
    status: 'done',
  });
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.itemId, newer.id);
  assert.equal(calls[1].message.text, newer.text);
});
