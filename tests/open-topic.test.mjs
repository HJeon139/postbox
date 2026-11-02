// #637: an agent opens a topic thread from any message of its conversation with open_topic, and the first message there
// reaches whom it mentions, as wake_agent's does (designs/508/637-open-topic.md). The tool calls the page's startTopic
// and wake_agent's path, so it adds no shape of its own. The agents are tests/side-threads-fixture.mjs's.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READ_TOOLS } from '../server/mcp.mjs';
import { threadCatchUp } from '../server/thread-summary.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The conversation with one message of yours and alpha's reply, both settled. */
async function conversation(f = setup()) {
  f.adapter.next.push(async (c) => c.text('The totals are off by one.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha check the totals' });
  await settle(f.rt);
  const items = f.store.items(f.t.id);
  return { ...f, mine: items.find((i) => i.kind === 'user'), reply: items.find((i) => i.kind === 'agent') };
}
/** One turn of alpha's, from a message in the conversation, that runs `step` with its tools; resolves with the step's result. */
async function alphaTurn(f, step) {
  let out;
  f.adapter.next.push(async (c) => {
    out = step(c.tools);
    c.text('Done.');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha go' });
  await settle(f.rt);
  return out;
}
const topics = (store) => Object.values(store.state.threads).filter((t) => t.kind === 'topic');

test('open_topic opens a topic from an agent’s message and from yours, and a second call returns the same thread', async () => {
  const f = await conversation();
  const one = await alphaTurn(f, (tools) => tools.open_topic({ itemId: f.reply.id }));
  assert.equal(one?.ok, true, JSON.stringify(one));
  const topic = topics(f.store)[0];
  assert.equal(topic.rootItemId, f.reply.id);
  assert.match(one.message, new RegExp(topic.id), 'the reply names the thread');
  const again = await alphaTurn(f, (tools) => tools.open_topic({ itemId: f.reply.id }));
  assert.equal(again?.threadId, topic.id, 'the same thread');
  const fromYours = await alphaTurn(f, (tools) => tools.open_topic({ itemId: f.mine.id }));
  assert.equal(fromYours?.ok, true);
  assert.equal(topics(f.store).length, 2);
  assert.equal(f.store.state.threads[fromYours.threadId].woke, 'alpha', 'the opener answers there first (I4)');
});

test('open_topic refuses an item in a topic thread and an item of another conversation', async () => {
  const f = await conversation();
  const { threadId } = f.rt.startTopic(f.t.id, f.reply.id);
  f.adapter.next.push(async (c) => c.text('In the thread.'));
  f.rt.sendMessage(threadId, { text: '@alpha reply here' });
  await settle(f.rt);
  const inTopic = f.store.items(threadId).find((i) => i.kind === 'agent');
  const other = f.rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [f.a.id] });
  f.rt.addItem(other.id, { kind: 'user', text: 'Elsewhere' });
  const elsewhere = f.store.items(other.id).at(-1);
  const r = await alphaTurn(f, (tools) => [tools.open_topic({ itemId: inTopic.id }), tools.open_topic({ itemId: elsewhere.id })]);
  assert.equal(r?.[0]?.ok, false);
  assert.match(r[0].message, /Reply in this one instead/);
  assert.equal(r[1]?.ok, false);
  assert.match(r[1].message, /can’t start a thread|isn’t in this conversation/);
  assert.equal(topics(f.store).length, 1, 'nothing opened');
});

test('a mention in the first message wakes that agent in the thread, and two mentions share one message', async () => {
  const f = await conversation();
  f.adapter.next.push(async (c) => c.text('Both fixes look right.'));
  const r = await alphaTurn(f, (tools) => tools.open_topic({ itemId: f.reply.id, message: '@beta please check the two fixes', mentions: ['beta'] }));
  assert.equal(r?.ok, true, JSON.stringify(r));
  await settle(f.rt);
  const items = f.store.items(r.threadId);
  assert.equal(items.filter((i) => i.kind === 'agent' && i.sessionId === f.alpha.id).length, 1, 'one first message');
  const asked = f.adapter.calls.find((c) => c.sessionId === f.beta.id);
  assert.equal(asked?.thread, r.threadId, 'beta was woken in the thread');
  assert.ok(
    items.some((i) => i.sessionId === f.beta.id && i.text === 'Both fixes look right.'),
    'and answered there',
  );
});

test('a repeated call with the same message, after the topic exists, posts nothing new (I6)', async () => {
  const f = await conversation();
  const first = await alphaTurn(f, (tools) => tools.open_topic({ itemId: f.reply.id, message: 'Notes on the totals' }));
  const again = await alphaTurn(f, (tools) => tools.open_topic({ itemId: f.reply.id, message: 'Notes on the totals' }));
  assert.equal(again?.threadId, first?.threadId);
  assert.equal(f.store.items(first.threadId).filter((i) => i.text === 'Notes on the totals').length, 1);
});

test('two opens of one item while a commit is held give one topic, through the pending read (I1)', async () => {
  const h = await heldStore();
  const f = await conversation(setup(h.store));
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const one = f.rt.startTopic(f.t.id, f.reply.id);
  const two = f.rt.startTopic(f.t.id, f.reply.id);
  assert.equal(two.threadId, one.threadId);
  h.release();
  await commit;
  await h.store.flush();
  assert.equal(topics(h.store).length, 1);
  await h.store.close();
});

test('open_topic is a tool agents are offered, and the store’s write gate refuses it while the store is closed (I5)', () => {
  assert.ok(
    TOOL_DEFS.some((t) => t.name === 'open_topic'),
    'offered to agents, locally and through a host’s shim',
  );
  assert.equal(READ_TOOLS.has('open_topic'), false, 'not a read, so storeClosedTo refuses it during ST-3');
});

test('#507: a thread’s catch-up keeps an ask that mentions the agent, whole, though 24 newer items pass its cap, and says what it left out', async () => {
  const f = await conversation();
  const { threadId } = f.rt.startTopic(f.t.id, f.reply.id);
  const say = (text) => f.rt.addItem(threadId, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
  const ask = `@alpha please re-run the totals for March and post the diff here. ${'Context on the run follows. '.repeat(6)}`;
  say(ask);
  for (let i = 0; i < 24; i++) say(`Note ${i + 1} on the run.`);
  const text = threadCatchUp(f.rt, f.store.state.sessions[f.alpha.id], threadId) ?? '';
  assert.ok(text.includes(ask), 'the ask is kept, whole');
  assert.match(text, /left out/, 'and the catch-up says what it left out');
});
