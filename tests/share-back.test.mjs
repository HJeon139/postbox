// Summarize back (#93) posts the thread agent’s reply in the conversation. Past SENDING.message (#362), as
// bring_to_conversation is, it isn’t posted: the thread says why, and the reply stays unsent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

const LIMIT = 50_000;
const summary = (n) => {
  const head = 'We chose “offsets” <i>&amp; "pages" \u0000 \uD800 ';
  return head + 'y'.repeat(n - head.length);
};
/** A topic thread on the person’s first message, whose agent writes text when asked to summarize it back. */
async function summarized(text) {
  const { store, rt, adapter, t } = setup();
  adapter.next.push(async (c) => c.text('Hi.'));
  rt.sendMessage(t.id, { text: '@alpha start' });
  await settle(rt);
  const { threadId } = rt.startTopic(t.id, store.items(t.id).find((x) => x.kind === 'user').id);
  adapter.next.push(async (c) => c.text(text));
  rt.summarizeBack(threadId);
  await settle(rt);
  const shared = store.items(t.id).filter((x) => x.kind === 'shared');
  const reply = store.items(threadId).find((x) => x.kind === 'agent' && x.text === text);
  return { shared, reply, store, threadId, rt };
}

test('#362: a summary exactly at the limit is posted in the conversation as written', async () => {
  const text = summary(LIMIT);
  assert.equal(text.length, LIMIT);
  const { shared, reply, store, threadId } = await summarized(text);
  assert.deepEqual(
    shared.map((x) => x.text),
    [text],
  );
  assert.ok(reply.sharedAt, 'the reply shows it was sent');
  assert.equal(store.state.threads[threadId].summaryPending, null);
});

test('#362: a summary one character past the limit isn’t posted, and the thread says why and what to do', async () => {
  const text = summary(LIMIT + 1);
  const { shared, reply, store, threadId, rt } = await summarized(text);
  assert.deepEqual(shared, [], 'nothing was posted in the conversation');
  assert.ok(reply, 'the summary stays in the thread');
  assert.equal(reply.sharedAt, undefined, 'so it isn’t marked sent');
  const why = store.items(threadId).findLast((x) => /up to 50,000 characters/.test(x.text ?? ''));
  assert.match(why?.text ?? '', /up to 50,000 characters, and this one has 50,001/);
  assert.match(why.text, /Summarize back/);
  // Postbox's line, never the person's: an agent would read a voice line as `You: …`, an instruction they gave.
  assert.equal(why.kind, 'system');
  assert.equal(why.variant, 'send-refused');
  assert.doesNotMatch(String(rt.describeItem(why) ?? ''), /^You:/, 'no agent hears it as the person');
  assert.equal(store.state.threads[threadId].summaryPending, null, 'Summarize back works again');
});
