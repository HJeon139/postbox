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

/** @beta, woken by @alpha in the topic, posts text with bring_to_conversation and replies. */
async function postFromTopic(f, text) {
  const topic = await withTopic(f);
  const out = {};
  f.adapter.next.push(async (c) => {
    out.result = c.tools.bring_to_conversation({ text });
    c.text('Posted.');
  });
  f.adapter.next.push(async (c) => c.text('On it.'));
  const calls = f.adapter.calls.length;
  f.rt.agentWake(f.alpha.id, 'beta', 'Review the PR here.', { replyIn: topic.id });
  await settle(f.rt);
  return { ...out, topic, calls: f.adapter.calls.slice(calls) };
}

// An outcome post an agent writes itself is its own message, so an @-mention in it wakes that agent in the
// conversation, as open_topic’s first message does: “A @mention always wakes” (#382, #1591).
test('#382: an outcome post wakes the agents it @-mentions in the conversation', async () => {
  const f = setup();
  const { result, topic, calls } = await postFromTopic(f, 'Review of PR #12: request changes. @alpha, fix the null check.');
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /@alpha/, 'the answer says who was woken');
  const shared = f.store.items(f.t.id).find((x) => x.kind === 'shared');
  assert.ok(shared, 'it was posted');
  const woken = calls.filter((c) => c.handle === 'alpha' && c.thread === f.t.id);
  assert.equal(woken.length, 1, 'the post woke @alpha in the conversation');
  // The wake points at the shared post, so the conversation holds the outcome once, not a second agent message too.
  assert.match(readOf(woken[0]), new RegExp(`\\[${shared.id}\\].*fix the null check`), 'the woken agent reads the shared post');
  assert.deepEqual(
    f.store
      .items(f.t.id)
      .filter((x) => /fix the null check/.test(x.text ?? ''))
      .map((x) => x.kind),
    ['shared'],
    'the outcome is in the conversation once',
  );
  // Naming an agent hands off, so beta’s reply in the topic doesn’t also go back to @alpha, who woke it there
  // (reply-back.mjs).
  assert.deepEqual(
    calls.filter((c) => c.thread === topic.id && c.handle === 'alpha'),
    [],
    'the reply went back to the waker as well',
  );
});

// A mention in code names no one, so nothing is woken in the conversation.
test('#382: an outcome post whose only mention is in code wakes no one', async () => {
  const f = setup();
  const { result, calls } = await postFromTopic(f, 'The handle is `@alpha`, for the record.');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    calls.filter((c) => c.thread === f.t.id).map((c) => c.handle),
    [],
    'a mention in code woke no one',
  );
});

// A post that names only its poster, or names an agent only in a quote, wakes no one, and its turn’s reply still goes
// back to the agent that woke it.
test('#382: an outcome post naming only its poster or a quoted agent wakes no one, and the reply still goes back', async () => {
  const f = setup();
  const { result, topic, calls } = await postFromTopic(f, '@beta here: the review is done.\n\n> @alpha asked for it earlier.');
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /no one was woken/);
  assert.deepEqual(
    calls.slice(0, 2).map((c) => [c.handle, c.thread]),
    [
      ['beta', topic.id],
      ['alpha', topic.id],
    ],
    'the wake, then the reply going back to @alpha in the topic',
  );
  assert.deepEqual(
    calls.filter((c) => c.thread === f.t.id),
    [],
    'nothing was woken in the conversation',
  );
});
