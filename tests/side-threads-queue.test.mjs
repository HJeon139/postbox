// Wakes with one session per agent (#228, #372): a wake for a busy agent waits in the queue of the thread it was sent
// in, where the person sees it, can remove it, and Send now keeps it; Stop drops it and tells the waker. The woken
// agent answers in the thread the waker spoke in, and its answer wakes the waker only by @-mentioning it. And the
// conversation’s pool is the only place an agent joins, from a topic thread too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveForks } from '../server/side-threads.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** A conversation with a topic thread on @alpha’s reply. */
async function withTopic() {
  const ctx = setup();
  const { rt, store, adapter, t } = ctx;
  adapter.next.push(async (c) => c.text('Here is converter.py.'));
  rt.sendMessage(t.id, { text: '@alpha write it' });
  await settle(rt);
  const reply = store.items(t.id).find((i) => i.kind === 'agent');
  return { ...ctx, topic: store.state.threads[rt.startTopic(t.id, reply.id).threadId] };
}

test('#228, #372: an agent in a topic thread that wakes another gets the answer there, and isn’t woken by it', async () => {
  const { store, rt, adapter, t, alpha, beta, topic } = await withTopic();
  adapter.next.push(async (c) => {
    c.tools.wake_agent({ handle: 'beta', message: 'Your opinion?' });
    c.text('Asked.');
  });
  adapter.next.push(async (c) => c.text('Looks fine.'));
  rt.sendMessage(topic.id, { text: '@alpha get the reviewer’s opinion' });
  await settle(rt);
  // The wake is @alpha’s message in the topic thread, and @beta answers there from its session in the conversation.
  const wake = store.items(topic.id).find((i) => i.kind === 'agent' && i.text === 'Your opinion?');
  assert.deepEqual([wake.sessionId, wake.hop], [alpha.id, 1]);
  const answer = adapter.calls.find((x) => x.sessionId === beta.id);
  assert.deepEqual([answer.thread, answer.message.from, answer.message.itemId], [topic.id, '@alpha', wake.id]);
  assert.ok(store.items(topic.id).some((i) => i.kind === 'agent' && i.sessionId === beta.id && i.text === 'Looks fine.'));
  // No reply goes back to @alpha: it reads the answer at its next turn.
  assert.equal(
    adapter.calls.some((x) => x.sessionId === alpha.id && x.message.from === '@beta'),
    false,
  );
  assert.equal(
    store.items(t.id).some((i) => i.text === 'Looks fine.' || i.text === 'Your opinion?'),
    false,
    'the exchange landed in the conversation',
  );
});

test('#228: Don’t add tells the waking agent in the thread it spoke from', async () => {
  const { store, rt, adapter, t, alpha, topic } = await withTopic();
  adapter.next.push(async (c) => {
    c.tools.wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
    c.text('Asked to add gamma.');
  });
  rt.sendMessage(topic.id, { text: '@alpha ask gamma' });
  await settle(rt);
  const card = store.items(t.id).find((i) => i.kind === 'hop' && i.join);
  rt.resolveHop(t.id, card.id, false);
  await settle(rt);
  const told = adapter.calls.at(-1);
  assert.deepEqual([told.sessionId, told.thread], [alpha.id, topic.id]);
  assert.match(told.message.text, /chose not to add @gamma/);
});

test('#228, #372: a queued wake shows in the conversation’s queue, can’t be edited, and Send now to the busy agent keeps it', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const long = held();
  adapter.next.push(long.step);
  rt.sendMessage(t.id, { text: '@beta the long job' });
  await sleep(5);
  rt.agentWake(alpha.id, 'beta', 'One question.');
  const [q] = store.state.threads[t.id].queue;
  assert.equal(q.kind, 'wake');
  assert.throws(() => rt.editQueued(t.id, q.id, 'Changed.'), /can’t be edited/);
  // You change course: Send now stops @beta’s turn, and the wake still waits for it.
  rt.sendMessage(t.id, { text: '@beta stop that, do this', sendNow: true });
  long.release();
  await settle(rt);
  const wake = adapter.calls.find((x) => x.message.text === 'One question.');
  assert.deepEqual([wake?.sessionId, wake?.thread], [beta.id, t.id]);
  assert.doesNotMatch(store.state.sessions[alpha.id].context?.join('\n') ?? '', /was stopped/);
});

test('#228, #372: another agent’s message waiting for an agent you stop isn’t lost: it hears it at its next turn', async () => {
  const { rt, adapter, t, alpha } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.sendMessage(t.id, { text: '@alpha a long job' });
  await sleep(5);
  // A message from @beta reaches @alpha while it’s busy: it waits behind @alpha’s turn.
  rt.deliver(alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' });
  rt.stop(alpha.id);
  h.release();
  await settle(rt);
  rt.sendMessage(t.id, { text: '@alpha anything?' });
  await settle(rt);
  assert.match((adapter.calls.at(-1).message.context ?? []).join('\n'), /@beta’s message came while your turn was stopped: “Here are the numbers\.”/);
});

test('#228: in a topic thread from before, whose fork never spoke, a message goes to its agent’s session in the conversation', async () => {
  const { store, rt, adapter, t, alpha, topic } = await withTopic();
  // As before #228: the thread’s fork, retired at startup, and neither who it started with nor a last speaker.
  const fork = rt.ensureSession(topic.id, alpha.personaId);
  rt.updateSession(fork.id, { forkOf: { sessionId: alpha.id, itemId: null }, archived: true, retiredFork: true });
  rt.putThread({ ...store.state.threads[topic.id], woke: undefined, lastSpeaker: null });
  rt.sendMessage(topic.id, { text: 'Still there?' });
  await settle(rt);
  assert.deepEqual([adapter.calls.at(-1).sessionId, adapter.calls.at(-1).thread], [alpha.id, topic.id]);
  assert.equal(rt.sessionsIn(t.id).length, 2);
});

test('#228: an agent approved from a proposal in a topic thread joins the conversation, not the thread', async () => {
  const { store, rt, adapter, t, alpha, topic } = await withTopic();
  adapter.next.push(async (c) => {
    c.tools.propose_agent({ handle: 'critic', description: 'Checks the math.' });
    c.text('Proposed.');
  });
  rt.sendMessage(topic.id, { text: '@alpha we need a critic' });
  await settle(rt);
  const proposal = store.items(topic.id).find((i) => i.kind === 'proposal');
  rt.resolveProposal(topic.id, proposal.id, 'create');
  assert.equal(rt.sessionsIn(topic.id).length, 0);
  assert.ok(rt.sessionsIn(t.id).some((x) => x.handle === 'critic'));
  assert.equal(alpha.threadId, t.id);
});

test('#228: your message in a topic thread starts the wake count again on the conversation, where wakes count', async () => {
  const { store, rt, t, alpha, topic } = await withTopic();
  // While beta answers, the chain runs (a chain that ends starts the count again by itself, #492).
  rt.agentWake(alpha.id, 'beta', 'One.');
  assert.equal(store.state.threads[t.id].hops, 1);
  rt.sendMessage(topic.id, { text: '@alpha carry on' });
  assert.equal(store.state.threads[t.id].hops, 0);
  await settle(rt);
});

test('#228, #372: an @-mention from a turn in a topic thread wakes the agent there, on that message, and its answer doesn’t wake the waker', async () => {
  const { store, rt, adapter, t, alpha, beta, topic } = await withTopic();
  adapter.next.push(async (c) => c.text('@beta your opinion on converter.py?'));
  adapter.next.push(async (c) => c.text('Looks fine.'));
  rt.sendMessage(topic.id, { text: '@alpha ask the reviewer' });
  await settle(rt);
  // The mention is the wake: @alpha’s message carries its number in the chain, and no second message is posted.
  const said = store.items(topic.id).filter((i) => i.kind === 'agent' && i.sessionId === alpha.id);
  assert.deepEqual(
    said.map((i) => [i.text, i.hop]),
    [['@beta your opinion on converter.py?', 1]],
  );
  const answer = adapter.calls.find((x) => x.sessionId === beta.id);
  assert.deepEqual([answer.thread, answer.message.from, answer.message.itemId], [topic.id, '@alpha', said[0].id]);
  assert.ok(store.items(topic.id).some((i) => i.sessionId === beta.id && i.text === 'Looks fine.'));
  assert.equal(
    adapter.calls.some((x) => x.sessionId === alpha.id && x.message.from === '@beta'),
    false,
  );
  assert.equal(
    store.items(t.id).some((i) => i.text === 'Looks fine.'),
    false,
  );
});

test('#228: a wake for an agent that’s archived, or that you remove from the queue, goes, and its agent is told', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.sendMessage(t.id, { text: '@beta the long job' });
  await sleep(5);
  rt.agentWake(alpha.id, 'beta', 'First question.');
  rt.agentWake(alpha.id, 'beta', 'Second question.');
  rt.cancelQueued(t.id, store.state.threads[t.id].queue[1].id);
  assert.match(store.state.sessions[alpha.id].context.at(-1), /The person removed your message \(“Second question\.”\) before it was answered/);
  rt.archive(beta.id);
  assert.deepEqual(store.state.threads[t.id].queue, []);
  assert.match(store.state.sessions[alpha.id].context.at(-1), /@beta was archived before it answered your message \(“First question\.”\)/);
  h.release();
  await settle(rt);
});

test('#228: a wake waiting for a busy agent doesn’t hold back a message behind it for another agent', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const b = held();
  const a = held();
  adapter.next.push(b.step);
  rt.sendMessage(t.id, { text: '@beta the long job' });
  await sleep(5);
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  adapter.next.push(a.step);
  rt.sendMessage(t.id, { text: '@alpha meanwhile, a word' });
  // @alpha’s turn, then a message for it that waits behind the wake for @beta.
  rt.sendMessage(t.id, { text: '@alpha and another' });
  assert.equal(store.state.threads[t.id].queue.length, 2);
  a.release();
  await sleep(30);
  assert.ok(
    adapter.calls.some((x) => x.sessionId === alpha.id && x.message.text === '@alpha and another'),
    'it waited for @beta',
  );
  assert.ok(rt.turns.has(beta.id), '@beta is still at work');
  b.release();
  await settle(rt);
});

test('#228: the migration retires a fork that was already archived, so Restore doesn’t bring it back', async () => {
  const { store, rt, t, alpha, topic } = await withTopic();
  const fork = rt.ensureSession(topic.id, alpha.personaId);
  rt.updateSession(fork.id, { forkOf: { sessionId: alpha.id, itemId: null }, archived: true, archivedAt: 1 });
  store.emit('settings', { forksArchived: false });
  archiveForks(rt);
  assert.deepEqual([store.state.sessions[fork.id].retiredFork, store.state.sessions[fork.id].archivedAt], [true, 1]);
  rt.archiveThread(t.id);
  rt.restoreThread(t.id);
  assert.equal(store.state.sessions[fork.id].archived, true);
  assert.ok(rt.sessionsIn(t.id).every((x) => !x.archived));
});
