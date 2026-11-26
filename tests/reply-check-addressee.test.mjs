// #1721: in a room of 23 November 2026 (Postbox v4.42.0), an agent ended its reply with review questions for another
// agent: “critic, please review … The points most worth a hostile read:” and four questions. The reply check asked for a
// form, the agent showed one, and the person got questions only that agent could answer. #1695 (v4.43.0) skips a reply
// that @-mentions an agent; this holds that for #1721's shape, and the nudge now says the form is for the person, so
// questions that name an agent without the @ are asked of it in the reply instead of put in a block.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockProblems, formatLint, lintMessage } from '../server/checks.mjs';
import { settle, setup } from './blocks-fixture.mjs';

// The reported reply's shape: a review request, then four questions for the reviewer. The words are ours.
const review = (/** @type {string} */ to) =>
  [
    `${to}, please review the retry rework at \`b9f92bbf\`. The points most worth a hostile read:`,
    '1. Does a refused retry ever leave the agent failed with nothing to start it?',
    '2. Can the check line reach a turn the person started meanwhile?',
    '3. Are Postbox’s own calls named when they make no step?',
    '4. Does a host turn’s call reach the same turn object?',
  ].join('\n');

test('#1721 a reply whose questions are for an agent it @-mentions gets no form nudge', async () => {
  const { rt, store, t, adapter } = setup();
  const lead = rt.createPersona({ handle: 'lead' });
  rt.ensureSession(t.id, lead.id);
  rt.threads.patch(t.id, () => ({ chainLimit: 2 }));
  const se = Object.values(store.state.sessions).find((s) => s.handle === 'lead' && s.threadId === t.id);
  adapter.next.push(async (c) => c.text(review('@critic')));
  rt.sendMessage(t.id, { text: '@lead hand the rework to critic' });
  await settle(rt);
  const lints = adapter.calls.filter((c) => c.sessionId === se.id && c.message.kind === 'lint');
  assert.deepEqual(
    lints.flatMap((c) => c.message.problems.map((p) => p.code)).filter((c) => c.endsWith('-in-prose')),
    [],
    'no reply-form problem',
  );
});

test('#1721 the lint turn for questions says the form is for the person, and an agent’s are asked with an @-mention', () => {
  const [p] = blockProblems(review('critic'));
  assert.equal(p.code, 'questions-in-prose');
  assert.match(p.message, /If they’re for the person, ask them in a form block/);
  const text = formatLint(lintMessage([p]));
  assert.match(text, /If they’re for the person, show that block now with show_block/);
  assert.match(text, /If they’re for another agent, show no block: only the person answers one\. Reply once instead, @-mentioning that agent/);
  assert.doesNotMatch(text, /^Show that block now/m, 'no plain order to show the block');
  assert.match(text, /Otherwise no reply is needed/);
});

test('#1721 options are treated the same; a long draft still just asks for its review block', () => {
  const options = formatLint(lintMessage(blockProblems('Two ways to fix it:\n1. Drop the hold\n2. Keep the report\n\nWhich do you want?')));
  assert.match(options, /If they’re for the person, offer them as a choice block/);
  assert.match(options, /If they’re for another agent, show no block/);
  const draft = Array.from({ length: 45 }, (_, i) => `Line ${i} of the draft.`).join('\n') + '\nPlease review.';
  const text = formatLint(lintMessage(blockProblems(draft)));
  assert.match(text, /^Show that block now with show_block/m);
  assert.match(text, /^No reply is needed/m);
});
