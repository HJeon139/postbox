// What reaches the conversation from a topic thread or a side thread from before #372: an old side thread’s line and
// its count (#130), what the person or an agent sends back (#128), and a failed turn where an agent was woken (#151).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { SENDING } from '../shared/limits.mjs';
import { held, oldSide, settle, setup, sleep } from './side-threads-fixture.mjs';

const linkOf = (store, t) => store.items(t.id).find((x) => x.kind === 'sidelink');
/** A topic thread on the person’s first message in the conversation, which @alpha answered. */
async function withTopic(f) {
  f.adapter.next.push(async (c) => c.text('Hi.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await settle(f.rt);
  const root = f.store.items(f.t.id).find((x) => x.kind === 'user');
  return f.store.state.threads[f.rt.startTopic(f.t.id, root.id).threadId];
}
/** A turn that posts two items, split by a code block between them, as one reply. */
const twoItems = async (c) => {
  c.text('First part.');
  c.tools.show_block({ block: { id: 'b1', type: 'code', version: 1, fallback: 'x', code: 'x' } });
  c.text('Second part.');
};

test('#130, #372: a side thread from before keeps its line’s count, one per agent turn, and catch-up says the same', async () => {
  const f = setup();
  const { store, rt, adapter, t, beta } = f;
  const side = oldSide(f);
  assert.equal(linkOf(store, t).count, 2);
  // A turn that was running there when side threads went finishes there: its two items count as one message.
  adapter.next.push(twoItems);
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'And the 1908 one?' }, { threadId: side.id });
  await settle(rt);
  assert.equal(store.items(side.id).filter((x) => x.kind === 'user' || x.kind === 'agent').length, 4);
  const link = linkOf(store, t);
  assert.equal(link.count, 3);
  assert.equal(link.lastAt, store.items(side.id).at(-1).at);
  // An agent of the conversation reads the same number.
  const gamma = rt.ensureSession(t.id, Object.values(store.state.personas).find((p) => p.handle === 'gamma').id);
  assert.match(rt.catchUp(store.state.sessions[gamma.id]) ?? '', /talked in a side thread \(3 messages;/);
});

test('#128: the person sends a message from a side thread from before to the conversation, as from a topic thread, and no one is woken', async () => {
  const f = setup();
  const { store, rt, adapter, t } = f;
  const side = oldSide(f, ['Status?', 'Status: 3 of 5 done, the parser is next.']);
  const reply = store.items(side.id).find((x) => x.kind === 'agent' && x.handle === 'beta');
  const calls = adapter.calls.length;
  rt.shareToConversation(side.id, reply.id);
  const shared = store.items(t.id).at(-1);
  assert.equal(shared.kind, 'shared');
  assert.deepEqual([shared.fromThreadId, shared.fromTitle, shared.handle, shared.text, shared.agent], [side.id, side.title, 'beta', reply.text, undefined]);
  assert.ok(store.item(side.id, reply.id).sharedAt);
  assert.throws(() => rt.shareToConversation(side.id, reply.id), /already in the conversation/);
  await settle(rt);
  assert.equal(adapter.calls.length, calls, 'Sending it woke an agent');
  // The conversation’s agents read it at their next turn.
  adapter.next.push(async (c) => c.text('ok'));
  rt.sendMessage(t.id, { text: '@alpha go on' });
  await settle(rt);
  assert.match(
    adapter.calls.at(-1).message.context?.join('\n') ?? adapter.calls.at(-1).message.text,
    /Shared from the thread “@alpha ↔ @beta”, by @beta: Status: 3 of 5/,
  );
});

test('#128, #372: an agent the person asked posts to the conversation from a topic thread, marked as shared by it', async () => {
  const f = setup();
  const { store, rt, adapter, t, alpha } = f;
  const topic = await withTopic(f);
  let result;
  // A turn another agent started there can’t: only the person asks for something to go to the conversation.
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'Unasked.' });
    c.text('Done.');
  });
  rt.agentWake(alpha.id, 'beta', 'Post these details in the main chat.', { replyIn: topic.id });
  await settle(rt);
  assert.equal(adapter.calls.at(-1).thread, topic.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /Only the person can ask for this/);
  assert.equal(store.items(t.id).filter((x) => x.kind === 'shared').length, 0);
  // The person asks in the topic thread.
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'The details, for the main chat.' });
    c.text('Posted it.');
  });
  rt.sendMessage(topic.id, { text: '@beta post these details in the main chat' });
  await settle(rt);
  assert.equal(result.ok, true, result.message);
  const shared = store.items(t.id).find((x) => x.kind === 'shared');
  assert.deepEqual([shared.fromThreadId, shared.handle, shared.text, shared.agent], [topic.id, 'beta', 'The details, for the main chat.', true]);
  // It wakes no one, and isn’t an agent wake; and your message there started the conversation’s wake count again.
  assert.equal(store.state.threads[t.id].hops, 0);
  assert.equal(
    rt.describeItem(shared, store.state.sessions[alpha.id]),
    `Shared from the thread “${topic.title}”, by @beta in a turn the person started: The details, for the main chat.`,
  );
});

test('#128: a topic thread’s agent can bring something to the conversation too, and the conversation’s agents can’t', async () => {
  const { store, rt, adapter, t } = setup();
  let result;
  // In the conversation itself there’s nowhere to bring it: it’s refused, and nothing is posted.
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'x' });
  });
  rt.sendMessage(t.id, { text: '@beta post it' });
  await settle(rt);
  assert.equal(result.ok, false);
  assert.equal(store.items(t.id).filter((x) => x.kind === 'shared').length, 0);
  // A topic thread’s agent can too.
  const root = store.items(t.id).find((x) => x.kind === 'user');
  const topic = store.state.threads[rt.startTopic(t.id, root.id).threadId];
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'From the topic.' });
  });
  rt.sendMessage(topic.id, { text: '@beta post this in the main chat' });
  await settle(rt);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    store
      .items(t.id)
      .filter((x) => x.kind === 'shared')
      .map((x) => [x.fromThreadId, x.agent]),
    [[topic.id, true]],
  );
});

test('#351: a wake_agent message or bring_to_conversation text past the limit is refused, and nothing is sent or posted', async () => {
  const { store, rt, adapter, t } = setup();
  const long = 'x'.repeat(SENDING.message + 1);
  let result;
  adapter.next.push(async (c) => {
    result = c.tools.wake_agent({ handle: 'beta', message: long });
  });
  rt.sendMessage(t.id, { text: '@alpha ask beta' });
  await settle(rt);
  assert.equal(result.ok, false);
  assert.match(result.message, /up to 50,000 characters, and this one has 50,001, so nothing was sent/);
  assert.deepEqual(
    adapter.calls.map((c) => c.handle),
    ['alpha'],
    'beta wasn’t woken',
  );
  assert.equal(
    store.items(t.id).some((x) => x.text === long),
    false,
    'nothing was posted',
  );
  // From a topic thread the person asked in, at the limit it posts; past it, it doesn’t.
  const root = store.items(t.id).find((x) => x.kind === 'user');
  const topic = rt.startTopic(t.id, root.id).threadId;
  for (const text of [long, 'y'.repeat(SENDING.message)]) {
    adapter.next.push(async (c) => {
      result = c.tools.bring_to_conversation({ text });
    });
    rt.sendMessage(topic, { text: '@beta post it in the main chat' });
    await settle(rt);
    assert.equal(result.ok, text !== long, result.message);
  }
  assert.deepEqual(
    store
      .items(t.id)
      .filter((x) => x.kind === 'shared')
      .map((x) => x.text.length),
    [SENDING.message],
  );
});

test('#128, #372: bring_to_conversation is offered over MCP only to the person’s turn in a topic thread', async () => {
  const f = setup();
  const { rt, adapter, t, alpha, beta } = f;
  const topic = await withTopic(f);
  const listFor = async (se) =>
    (await handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, rt.turns.get(se.id)?.token ?? null)).result.tools.map((x) => x.name);
  /** The tools a turn is offered, while it runs. */
  const offered = async (se, start) => {
    const h = held();
    adapter.next.push(h.step);
    start();
    await sleep(5);
    const tools = await listFor(se);
    h.release();
    await settle(rt);
    assert.ok(tools.includes('wake_agent'));
    return tools.includes('bring_to_conversation');
  };
  // A wake, in the conversation or in a topic thread: another agent started it.
  assert.equal(await offered(beta, () => rt.agentWake(alpha.id, 'beta', 'Look at this.')), false);
  assert.equal(await offered(beta, () => rt.agentWake(alpha.id, 'beta', 'And this.', { replyIn: topic.id })), false);
  assert.equal(await offered(beta, () => rt.sendMessage(topic.id, { text: '@beta and post it in the main chat' })), true);
  assert.equal(await offered(alpha, () => rt.sendMessage(t.id, { text: '@alpha hello' })), false);
});

test('#151, #372: a failed wake in a topic thread needs you there, and Retry answers the wake again, with no reply to the agent that asked', async () => {
  const f = setup();
  const { store, rt, adapter, alpha, beta } = f;
  const topic = await withTopic(f);
  adapter.next.push(async () => {
    throw new Error('API 500');
  });
  const before = adapter.calls.length;
  rt.agentWake(alpha.id, 'beta', 'Review the plan.', { replyIn: topic.id });
  await settle(rt);
  const failed = store.items(topic.id).find((x) => x.status === 'failed');
  assert.equal(failed.handle, 'beta');
  // The room sees it: beta needs you, at the card in the topic thread.
  assert.deepEqual(store.state.sessions[beta.id].needs, { kind: 'failed', itemId: failed.id, text: 'API 500', threadId: topic.id });
  // Retry is the wake again, in the topic thread, and its answer stays there: @alpha isn’t woken by it.
  adapter.next.push(async (c) => c.text('Looks right.'));
  rt.retry(topic.id, failed.id);
  await settle(rt);
  const calls = adapter.calls.slice(before);
  assert.deepEqual(
    calls.map((c) => [c.handle, c.message.kind, c.message.from, c.message.text, c.thread]),
    [
      ['beta', 'agent', '@alpha', 'Review the plan.', topic.id],
      ['beta', 'agent', '@alpha', 'Review the plan.', topic.id],
    ],
  );
  assert.equal(store.item(topic.id, failed.id).status, 'retried');
  assert.ok(store.items(topic.id).some((x) => x.kind === 'agent' && x.handle === 'beta' && x.text === 'Looks right.'));
  assert.equal(store.state.sessions[beta.id].needs, null);
});

test('#151: Retry sends a failed turn again as it was asked, so an agent’s turn never comes back as the person’s', async () => {
  const f = setup();
  const { store, rt, adapter, t, beta } = f;
  const topic = await withTopic(f);
  // An agent’s message to beta in the topic thread, not your message there, whose turn fails.
  adapter.next.push(async () => {
    throw new Error('API 500');
  });
  rt.deliver(beta.id, { kind: 'agent', from: '@gamma', text: 'Here are the numbers.' }, { threadId: topic.id });
  await settle(rt);
  const failed = store.items(topic.id).find((x) => x.status === 'failed');
  let result;
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'Unasked post.' });
  });
  rt.retry(topic.id, failed.id);
  await settle(rt);
  const retried = adapter.calls.at(-1);
  assert.deepEqual(
    [retried.thread, retried.message.kind, retried.message.from, retried.message.text, retried.message.retry],
    [topic.id, 'agent', '@gamma', 'Here are the numbers.', true],
  );
  // So it isn’t the person’s turn, and can’t post to the conversation.
  assert.equal(result.ok, false);
  assert.equal(store.items(t.id).filter((x) => x.kind === 'shared').length, 0);
});

test('#128, #228, #372: a wake from an agent that answered in a topic thread, made once its turn there is over, runs in the conversation', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text('Hi.'));
  rt.sendMessage(t.id, { text: '@beta start' });
  await settle(rt);
  const root = store.items(t.id).find((x) => x.kind === 'user');
  const topic = store.state.threads[rt.startTopic(t.id, root.id).threadId];
  adapter.next.push(async (c) => c.text('ok'));
  rt.sendMessage(topic.id, { text: '@beta here' });
  await settle(rt);
  // @beta answered there from its one session in the conversation, and that turn is over: a wake it makes now is in
  // the conversation, its own thread, and opens no side thread.
  rt.agentWake(beta.id, 'alpha', 'Check it.');
  await settle(rt);
  assert.deepEqual([adapter.calls.at(-1).sessionId, adapter.calls.at(-1).thread], [alpha.id, t.id]);
  assert.ok(store.items(t.id).some((x) => x.kind === 'agent' && x.handle === 'beta' && x.text === 'Check it.' && x.hop === 1));
  assert.equal(
    store.items(topic.id).some((x) => x.text === 'Check it.'),
    false,
  );
  assert.equal(Object.values(store.state.threads).filter((x) => x.kind === 'side').length, 0);
  // A person’s turn in a side thread of a topic, whose post went to the conversation, is gone with side threads (#372).
});
