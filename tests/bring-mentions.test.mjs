// bring_to_conversation’s post is the agent’s own message (#382), so the agents it @-mentions wake in the conversation,
// as open_topic’s first message wakes its own: the owner’s “A @mention always wakes” (#1591) holds for it too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';
import { readOf } from './turn-parts.mjs';

/** A topic thread on the person’s first message, after @alpha’s first turn. */
async function withTopic(f) {
  f.adapter.next.push(async (c) => c.text('Hi.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha start' });
  await settle(f.rt);
  const root = f.store.items(f.t.id).find((x) => x.kind === 'user');
  return f.store.state.threads[f.rt.startTopic(f.t.id, root.id).threadId];
}

// An outcome post an agent writes itself is its own message, so an @-mention in it wakes that agent in the
// conversation, as open_topic’s first message does: “A @mention always wakes” (#382, #1591). One in code wakes no one.
test('#382: an outcome post wakes the agents it @-mentions in the conversation, and a mention in code wakes no one', async () => {
  const f = setup();
  const { store, rt, adapter, t, alpha } = f;
  const topic = await withTopic(f);
  let result;
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'Review of PR #12: request changes. @alpha, fix the null check.' });
    c.text('Posted.');
  });
  adapter.next.push(async (c) => c.text('On it.'));
  const calls = adapter.calls.length;
  rt.agentWake(alpha.id, 'beta', 'Review the PR here.', { replyIn: topic.id });
  await settle(rt);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /@alpha/, 'the answer says who was woken');
  const shared = store.items(t.id).find((x) => x.kind === 'shared');
  const woken = adapter.calls.slice(calls).filter((c) => c.handle === 'alpha' && c.thread === t.id);
  assert.equal(woken.length, 1, 'the post woke @alpha in the conversation');
  assert.match(readOf(woken[0]), /fix the null check/);
  assert.ok(shared, 'and it was posted');
  // Naming an agent hands off, so the turn’s reply doesn’t also go back to @alpha, who woke it (reply-back.mjs).
  assert.deepEqual(
    adapter.calls.slice(calls).filter((c) => c.thread === topic.id && c.handle === 'alpha'),
    [],
    'the reply went back to the waker as well',
  );
  // A mention in code names no one, so nothing is woken in the conversation.
  adapter.next.push(async (c) => {
    result = c.tools.bring_to_conversation({ text: 'The handle is `@alpha`, for the record.' });
    c.text('Posted again.');
  });
  const before = adapter.calls.length;
  rt.agentWake(alpha.id, 'beta', 'One more note.', { replyIn: topic.id });
  await settle(rt);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    adapter.calls
      .slice(before)
      .filter((c) => c.thread === t.id)
      .map((c) => c.handle),
    [],
    'a mention in code woke no one',
  );
});
