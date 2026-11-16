// Queued wakes become one turn per agent and thread, with stale work removed when delivery starts (#374).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { batchPending } from '../server/message-queue.mjs';
import { combineMessages } from '../server/queue-batch.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

test('three waiting mentions from different agents become one turn with each sender, in arrival order', async () => {
  const { rt, adapter, t, beta, c, alpha } = setup();
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
  assert.equal(arrange.waitingEntries(rt, beta.id).length, 3, 'each waits in beta’s inbox until its turn ends');
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2, 'one initial turn and one batch');
  assert.deepEqual(
    calls[1].parts.map((message) => [message.from, message.text]),
    [
      ['@alpha', 'First'],
      ['@gamma', 'Second'],
      ['@delta', 'Third'],
    ],
  );
  assert.match(formatMessage(calls[1].message), /@alpha[\s\S]*@gamma[\s\S]*@delta/);
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
});

test('a later message from a waker doesn’t replace its waiting one: both reach the agent in one turn', async () => {
  // designs/rooms-at-scale.md, “Delivery”: nothing is held, merged or dropped. #374 replaced the older one.
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Review the old revision.');
  rt.agentWake(alpha.id, 'beta', 'Review the new revision.');
  assert.equal(arrange.waitingEntries(rt, beta.id).length, 2);
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].parts.map((m) => m.text.split('\n')[0]),
    ['Review the old revision.', 'Review the new revision.'],
  );
});

test('a waker’s unaddressed later post is named on its waiting mention as posted since, not put in its place', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Please check it.');
  const later = arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'I already resolved it.', status: 'done' });
  busy.release();
  await settle(rt);
  const calls = adapter.calls.filter((call) => call.sessionId === beta.id);
  assert.equal(calls.length, 2, 'one initial turn and one with the mention');
  assert.equal(calls[1].parts[0].text, `Please check it.\n(The same sender posted since: [${later.id}])`);
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
    calls[1].parts.map((message) => message.kind),
    ['agent', 'user', 'agent'],
  );
  assert.equal(store.items(t.id).filter((item) => item.kind === 'user' && item.text === '@beta include the second point.').length, 1);
});

test('a waker finishing the same turn does not supersede its own queued handoff', async () => {
  const { rt, store, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Please review.', { fromTurnId: 'source-turn' });
  arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', turnId: 'source-turn', text: 'I asked for review.', status: 'done' });
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((call) => call.sessionId === beta.id)[1].parts[0].text, 'Please review.');
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
    calls[1].parts.map((message) => message.text),
    ['Pending one.', 'Pending two.', 'Queued third.'],
  );
});

test('a batch never combines messages from the conversation and a topic thread', async () => {
  const { rt, adapter, t, alpha, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const root = arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
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
    calls.slice(1).map((call) => [call.thread, call.parts[0].text]),
    [
      [t.id, 'In the conversation.'],
      [topic, 'In the topic.'],
    ],
  );
});

test('a post in another thread does not supersede a queued wake in the conversation', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const root = arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Still needed.');
  arrange.post(rt, topic, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'Different topic.', status: 'done' });
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((call) => call.sessionId === beta.id)[1].parts[0].text, 'Still needed.');
});

test('a later post noted on a waiting mention doesn’t strand a queued message addressed to several agents', async () => {
  const { rt, store, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta start' });
  rt.agentWake(alpha.id, 'beta', 'Obsolete request.');
  const resolved = arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'Already resolved.', status: 'done' });
  rt.sendMessage(t.id, { text: '@alpha @beta the shared next task.' });
  busy.release();
  await settle(rt);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  const delivered = adapter.calls.flatMap((call) => call.parts ?? [call.message]);
  assert.equal(delivered.filter((message) => message.text === '@alpha @beta the shared next task.').length, 2);
  assert.equal(delivered.filter((message) => message.text?.startsWith('Obsolete request.') && message.text.includes(resolved.id)).length, 1);
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
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
    calls[1].parts.map((message) => message.text),
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
  arrange.post(rt, t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', turnId: 'new-turn', text: '', status: 'streaming' });
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((call) => call.sessionId === beta.id)[1].parts[0].text, 'Still needs review.');
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
    const item = arrange.post(rt, t.id, { kind: 'agent', handle, turnId, text, status: 'done' });
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
  const old = arrange.post(rt, t.id, { kind: 'agent', handle: 'alpha', turnId: 'old', text: 'Please review.' });
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: old.text, itemId: old.id, at: old.at });
  const newer = arrange.post(rt, t.id, {
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
  assert.equal(calls[1].parts[0].text, newer.text);
});
