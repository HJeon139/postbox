// An agent’s @-mention wakes the other agent with what it said (#362): past SENDING.message, as wake_agent and
// bring_to_conversation do, the wake is refused and the agent is told why, so it can send less with wake_agent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

const LIMIT = 50_000;
/** A reply that @-mentions beta, with characters a careless check would mangle, padded to n characters. */
const reply = (n) => {
  const head = '@beta check “this” <b>&amp; "quoted" \u0000 \uD800 ';
  return head + 'x'.repeat(n - head.length);
};
/** What beta was sent by alpha’s turn that says text, and what alpha is told at its next turn. */
async function mention(text) {
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text(text));
  rt.sendMessage(t.id, { text: '@alpha go' });
  await settle(rt);
  const woke = adapter.calls.filter((c) => c.sessionId === beta.id);
  return { woke, told: store.state.sessions[alpha.id].context ?? [], store, t };
}

test('#362: a reply exactly at the limit wakes the agent it mentions, with every character as written', async () => {
  const text = reply(LIMIT);
  assert.equal(text.length, LIMIT);
  const { woke, told } = await mention(text);
  assert.equal(woke.length, 1, 'beta was woken');
  assert.ok(JSON.stringify(woke[0].message).includes(JSON.stringify(text).slice(1, -1)), 'beta got the reply unchanged');
  assert.deepEqual(
    told.filter((x) => /woke no one/.test(x)),
    [],
  );
});

test('#362: a reply one character past the limit wakes no one; the conversation says so, and the agent gets one turn to hand off with wake_agent', async () => {
  // No markup in this one, so no lint notice takes the agent's next turn.
  const text = `@beta check “this” & "quoted" \u0000 \uD800 ${'x'.repeat(LIMIT + 1)}`.slice(0, LIMIT + 1);
  const { store, rt, adapter, t, alpha, beta } = setup();
  adapter.next.push(async (c) => c.text(text));
  // Its turn on the notice is long again: it isn't woken a second time, so a long reply can't loop.
  adapter.next.push(async (c) => c.text(text));
  rt.sendMessage(t.id, { text: '@alpha go' });
  await settle(rt);
  assert.equal(adapter.calls.filter((c) => c.sessionId === beta.id).length, 0, 'beta wasn’t woken');
  const alphaTurns = adapter.calls.filter((c) => c.sessionId === alpha.id);
  assert.equal(alphaTurns.length, 2, 'alpha got exactly one more turn');
  const notice = JSON.stringify(alphaTurns[1].message);
  assert.match(notice, /Your mention of @beta woke no one/);
  assert.match(notice, /your reply has 50,001 characters, past the 50,000 a hand-off can send, so nothing was sent\./);
  assert.match(notice, /wake_agent/);
  const lines = store.items(t.id).filter((x) => /woke no one/.test(x.text ?? ''));
  assert.equal(lines.length, 2, 'a line for each refused hand-off, so the person sees why beta never started');
  // Postbox's lines, never the person's: beta would read a voice line as `You: …`, words the person never said.
  assert.deepEqual(
    lines.map((x) => `${x.kind}/${x.variant}`),
    ['system/send-refused', 'system/send-refused'],
  );
  assert.doesNotMatch(String(rt.describeItem(lines[0]) ?? ''), /^You:/, 'no agent hears it as the person');
  assert.match(lines[0].text, /^@alpha’s mention of @beta woke no one: its reply has 50,001 characters, past the 50,000 a hand-off can send\.$/);
  // The reply itself is still in the conversation, as the agent wrote it, with no wake marked on it.
  const posted = store.items(t.id).find((x) => x.kind === 'agent' && x.text === text);
  assert.ok(posted, 'the reply was posted');
  assert.equal(posted.hop, undefined, 'no wake went out as it');
  assert.equal(store.state.threads[t.id].hops ?? 0, 0, 'the chain didn’t move');
});

test('#362: in a topic thread, the refusal line and the notice turn stay in the topic thread', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  adapter.next.push(async (c) => c.text('Hi.'));
  rt.sendMessage(t.id, { text: '@alpha start' });
  await settle(rt);
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((x) => x.kind === 'user').id);
  // No markup, so no lint notice takes the agent's next turn.
  adapter.next.push(async (c) => c.text(`@beta ${'x'.repeat(LIMIT)}`));
  adapter.next.push(async (c) => c.text('Handed off with wake_agent.'));
  rt.sendMessage(threadId, { text: '@alpha go' });
  await settle(rt);
  assert.equal(adapter.calls.filter((c) => c.sessionId === alpha.id).length, 3, 'alpha got its notice turn');
  const inTopic = store.items(threadId);
  assert.ok(
    inTopic.some((x) => x.kind === 'system' && /woke no one/.test(x.text ?? '')),
    'the line is in the topic thread',
  );
  assert.ok(
    inTopic.some((x) => x.kind === 'agent' && x.text === 'Handed off with wake_agent.'),
    'the notice turn answered in the topic thread',
  );
  assert.ok(!store.items(t.id).some((x) => x.text === 'Handed off with wake_agent.'), 'not in the conversation');
});
