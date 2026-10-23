// What reaches the conversation from a side thread: its line’s count (#130), what the person or an agent sends back
// (#128), and a failed turn there (#151).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { held, settle, setup, sideOf, sleep } from './side-threads-fixture.mjs';

const linkOf = (store, t) => store.items(t.id).find((x) => x.kind === 'sidelink');
/** A turn that posts two items, split by a code block between them, as one reply. */
const twoItems = async (c) => {
  c.text('First part.');
  c.tools.show_block({ block: { id: 'b1', type: 'code', version: 1, fallback: 'x', code: 'x' } });
  c.text('Second part.');
};

test('#130: the side-thread line counts every message there, one per agent turn, and catch-up says the same', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(twoItems);
  rt.agentWake(alpha.id, 'beta', 'Which editions?');
  await settle(rt);
  const side = sideOf(store, t);
  // The wake, and beta’s turn of two items: alpha hears the reply in a turn of its own, in the conversation.
  assert.equal(linkOf(store, t).count, 2);
  // The person joins the side thread, and beta answers them: no wake, no reply to one.
  adapter.next.push(async (c) => c.text('Here you go.'));
  rt.sendMessage(side.id, { text: '@beta what about the 1908 one?' });
  await settle(rt);
  assert.equal(store.items(side.id).filter((x) => x.kind === 'user' || x.kind === 'agent').length, 5);
  const link = linkOf(store, t);
  assert.equal(link.count, 4);
  assert.equal(link.lastAt, store.items(side.id).at(-1).at);
  // An agent of the conversation reads the same number.
  const gamma = rt.ensureSession(t.id, Object.values(store.state.personas).find((p) => p.handle === 'gamma').id);
  assert.match(rt.catchUp(store.state.sessions[gamma.id]) ?? '', /talked in a side thread \(4 messages;/);
});

test('#128: the person sends a side-thread message to the conversation, as from a topic thread, and no one is woken', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => c.text('Status: 3 of 5 done, the parser is next.'));
  rt.agentWake(alpha.id, 'beta', 'Status?');
  await settle(rt);
  const side = sideOf(store, t);
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

test('#128: an agent the person asked posts to the conversation from a side or topic thread, marked as shared by it', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  let result;
  // A turn another agent started can’t: only the person asks for something to go to the conversation.
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'Unasked.' });
    c.text('Done.');
  });
  rt.agentWake(alpha.id, 'beta', 'Post these details in the main chat.');
  await settle(rt);
  assert.equal(result.ok, false);
  assert.match(result.message, /Only the person can ask for this/);
  assert.equal(store.items(t.id).filter((x) => x.kind === 'shared').length, 0);
  // The person asks in the side thread.
  const side = sideOf(store, t);
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'The details, for the main chat.' });
    c.text('Posted it.');
  });
  rt.sendMessage(side.id, { text: '@beta post these details in the main chat' });
  await settle(rt);
  assert.equal(result.ok, true, result.message);
  const shared = store.items(t.id).find((x) => x.kind === 'shared');
  assert.deepEqual([shared.fromThreadId, shared.handle, shared.text, shared.agent], [side.id, 'beta', 'The details, for the main chat.', true]);
  // It wakes no one, and isn’t an agent wake: the count is the one wake that started the side thread.
  assert.equal(store.state.threads[t.id].hops, 1);
  assert.match(
    rt.describeItem(shared, store.state.sessions[alpha.id]),
    /Shared from the thread “@alpha ↔ @beta”, by @beta in a turn the person started: The details/,
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

test('#128: bring_to_conversation is offered over MCP only to the person’s turn in a side or topic thread', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
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
  // A wake into a side thread: another agent started it.
  assert.equal(await offered(beta, () => rt.agentWake(alpha.id, 'beta', 'Look at this.')), false);
  assert.equal(await offered(beta, () => rt.sendMessage(sideOf(store, t).id, { text: '@beta and post it in the main chat' })), true);
  assert.equal(await offered(alpha, () => rt.sendMessage(t.id, { text: '@alpha hello' })), false);
});

test('#151: a failed turn in a side thread needs you there, and Retry answers the wake again, to the agent that asked', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async () => {
    throw new Error('API 500');
  });
  rt.agentWake(alpha.id, 'beta', 'Review the plan.');
  await settle(rt);
  const side = sideOf(store, t);
  const failed = store.items(side.id).find((x) => x.status === 'failed');
  assert.equal(failed.handle, 'beta');
  // The room sees it: beta needs you, at the card in the side thread.
  assert.deepEqual(store.state.sessions[beta.id].needs, { kind: 'failed', itemId: failed.id, text: 'API 500', threadId: side.id });
  // Retry is the wake again, in the side thread, and the reply goes back to alpha.
  adapter.next.push(async (c) => c.text('Looks right.'));
  adapter.next.push(async (c) => c.text('Thanks.'));
  rt.retry(side.id, failed.id);
  await settle(rt);
  const [retried, heard] = adapter.calls.slice(-2);
  assert.deepEqual(
    [retried.handle, retried.message.kind, retried.message.from, retried.message.text, retried.thread],
    ['beta', 'agent', '@alpha', 'Review the plan.', side.id],
  );
  assert.deepEqual([heard.handle, heard.message.from, heard.message.text], ['alpha', '@beta', 'Looks right.']);
  assert.equal(store.item(side.id, failed.id).status, 'retried');
  // The failed turn said nothing, so the line counts the wake and the reply that came on Retry (#130).
  assert.equal(linkOf(store, t).count, 2);
  assert.equal(store.state.sessions[beta.id].needs, null);
});

test('#151: Retry sends a failed turn again as it was asked, so an agent’s turn never comes back as the person’s', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  rt.agentWake(alpha.id, 'beta', 'Look at this.');
  await settle(rt);
  const side = sideOf(store, t);
  // An agent’s message to beta in the side thread, not a wake (as a fork hears a reply), whose turn fails.
  adapter.next.push(async () => {
    throw new Error('API 500');
  });
  rt.deliver(beta.id, { kind: 'agent', from: '@gamma', text: 'Here are the numbers.' }, { threadId: side.id });
  await settle(rt);
  const failed = store.items(side.id).find((x) => x.status === 'failed');
  let result;
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'Unasked post.' });
  });
  rt.retry(side.id, failed.id);
  await settle(rt);
  const retried = adapter.calls.at(-1).message;
  assert.deepEqual([retried.kind, retried.from, retried.text, retried.retry], ['agent', '@gamma', 'Here are the numbers.', true]);
  // So it isn’t the person’s turn, and can’t post to the conversation.
  assert.equal(result.ok, false);
  assert.equal(store.items(t.id).filter((x) => x.kind === 'shared').length, 0);
});

test('#128: from a side thread of a topic thread, bring_to_conversation posts in the conversation, not the topic', async () => {
  const { store, rt, adapter, t, beta } = setup();
  adapter.next.push(async (c) => c.text('Hi.'));
  rt.sendMessage(t.id, { text: '@beta start' });
  await settle(rt);
  const root = store.items(t.id).find((x) => x.kind === 'user');
  const topic = store.state.threads[rt.startTopic(t.id, root.id).threadId];
  adapter.next.push(async (c) => c.text('ok'));
  rt.sendMessage(topic.id, { text: '@beta here' });
  await settle(rt);
  // The topic’s agent wakes another: their side thread hangs off the topic thread.
  const forked = rt.sessionsIn(topic.id).find((x) => x.personaId === beta.personaId);
  rt.agentWake(forked.id, 'alpha', 'Check it.');
  await settle(rt);
  const side = Object.values(store.state.threads).find((x) => x.kind === 'side' && x.parentId === topic.id);
  let result;
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'For the main chat.' });
  });
  rt.sendMessage(side.id, { text: '@alpha post it in the main chat' });
  await settle(rt);
  assert.equal(result.ok, true, result.message);
  assert.equal(store.items(t.id).find((x) => x.kind === 'shared')?.text, 'For the main chat.');
  assert.equal(store.items(topic.id).filter((x) => x.kind === 'shared').length, 0);
});
