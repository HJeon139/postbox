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

test('#362: a reply one character past the limit wakes no one, and the agent is told how long it was and to send less', async () => {
  const text = reply(LIMIT + 1);
  const { woke, told, store, t } = await mention(text);
  assert.equal(woke.length, 0, 'beta wasn’t woken');
  const note = told.find((x) => /Your mention of @beta woke no one/.test(x));
  assert.ok(note, JSON.stringify(told));
  assert.match(note, /up to 50,000 characters, and this one has 50,001, so nothing was sent\. Send less\./);
  // The reply itself is still in the conversation, as the agent wrote it, with no wake marked on it.
  const posted = store.items(t.id).find((x) => x.kind === 'agent' && x.text === text);
  assert.ok(posted, 'the reply was posted');
  assert.equal(posted.hop, undefined, 'no wake went out as it');
  assert.equal(store.state.threads[t.id].hops ?? 0, 0, 'the chain didn’t move');
});
