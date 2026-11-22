// The person’s answer to a block, as another agent reads it (#1253): the line names the block it answered, whose it
// is and its id, so an agent coordinating a room with two open reviews can tell which one was answered without asking.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

/** A block alpha showed, and the person’s answer to it. */
function answered(f, block, voice) {
  const shown = arrange.post(f.rt, f.t.id, {
    kind: 'block',
    sessionId: f.alpha.id,
    personaId: f.alpha.personaId,
    handle: 'alpha',
    valid: true,
    block,
  });
  return arrange.post(f.rt, f.t.id, { kind: 'voice', text: voice, blockItemId: shown.id });
}

test('#1253: another agent reads which block the person answered, whose it is and its id', () => {
  const f = setup();
  const review = { type: 'review', id: 'plan-draft-2', version: 1, title: 'Release plan', content: 'Ship it.', format: 'markdown' };
  const it = answered(f, review, 'Submitted review: Request changes · 3 comments');
  assert.equal(
    arrange.describeItem(f.rt, it, f.beta),
    'The person answered @alpha’s review “Release plan” (plan-draft-2): Submitted review: Request changes · 3 comments',
  );
});

test('#1253: a choice’s answer names its block the same way', () => {
  const f = setup();
  const choice = { type: 'choice', id: 'pick-1', version: 1, title: 'Which source first?', options: [{ id: 'a', label: 'The papers' }] };
  const it = answered(f, choice, 'Chose: The papers');
  assert.equal(arrange.describeItem(f.rt, it, f.beta), 'The person answered @alpha’s choice “Which source first?” (pick-1): Chose: The papers');
});

test('#1253: the block’s own agent still hears it as an event, and a line with no block reads as before', () => {
  const f = setup();
  const it = answered(f, { type: 'choice', id: 'pick-2', version: 1, title: 'Which?', options: [{ id: 'a', label: 'A' }] }, 'Chose: A');
  assert.equal(arrange.describeItem(f.rt, it, f.alpha), null);
  const plain = arrange.post(f.rt, f.t.id, { kind: 'voice', text: 'Approved.' });
  assert.equal(arrange.describeItem(f.rt, plain, f.beta), 'The person: Approved.');
});

/** alpha’s review “Release plan”, answered with Request changes and two comments. @param {string} content */
function reviewed(f, content) {
  const block = { type: 'review', id: 'plan-draft-2', version: 1, title: 'Release plan', content, format: 'markdown' };
  const voice = 'Submitted review: Request changes · 2 comments';
  const values = {
    verdict: 'request_changes',
    comments: [
      { line: 12, text: 'Cut the second rollout step.' },
      { line: 40, text: 'Name the owner.' },
    ],
  };
  const shown = arrange.post(f.rt, f.t.id, {
    kind: 'block',
    sessionId: f.alpha.id,
    personaId: f.alpha.personaId,
    handle: 'alpha',
    valid: true,
    block,
    answered: true,
    answer: { action: 'submit', values, voice },
  });
  // As server/blocks.mjs writes it: the line keeps the block it answered and this answer’s comments.
  const answerTo = { id: block.id, type: block.type, handle: 'alpha', title: block.title };
  const line = arrange.post(f.rt, f.t.id, { kind: 'voice', text: voice, blockItemId: shown.id, answerTo, comments: values.comments });
  return { shown, line };
}

test('#1253: another agent reads the comments that came with the person’s review', () => {
  const f = setup();
  const { line } = reviewed(f, 'Ship it.');
  const read = arrange.describeItem(f.rt, line, f.beta);
  assert.match(read, /^The person answered @alpha’s review “Release plan” \(plan-draft-2\): Submitted review: Request changes · 2 comments/);
  assert.match(read, /line 12: Cut the second rollout step\./);
  assert.match(read, /line 40: Name the owner\./);
});

test('#1253: the comments of a review longer than the cut reach the room on the answer’s own line', () => {
  // The block’s own line is cut at READING.item, and its answer comes last; the answer line carries the verdict and the
  // comments, so they arrive whatever the block’s length.
  const f = setup();
  const { shown, line } = reviewed(f, `${'The plan, at length. '.repeat(400)}`);
  assert.doesNotMatch(arrange.describeItem(f.rt, shown, f.beta), /Name the owner/, 'the block’s line is cut first');
  const read = arrange.describeItem(f.rt, line, f.beta);
  assert.match(read, /Request changes/);
  assert.match(read, /line 12: Cut the second rollout step\./);
  assert.match(read, /line 40: Name the owner\./);
});

test('#1253: comments cut on the answer line point at the block, whose reading has them whole', () => {
  // Pre-review: read_message on the answer line has no comments, so a cut must send the agent to the block.
  const f = setup();
  const long = 'Rework this section. '.repeat(150);
  const block = { type: 'review', id: 'plan-draft-3', version: 1, title: 'Release plan', content: 'Ship it.', format: 'markdown' };
  const voice = 'Submitted review: Request changes · 1 comment';
  const shown = arrange.post(f.rt, f.t.id, {
    kind: 'block',
    sessionId: f.alpha.id,
    personaId: f.alpha.personaId,
    handle: 'alpha',
    valid: true,
    block,
    answered: true,
    answer: { action: 'submit', values: { verdict: 'request_changes', comments: [{ line: 3, text: long }] }, voice },
  });
  const answerTo = { id: block.id, type: block.type, handle: 'alpha', title: block.title };
  const comments = [{ line: 3, text: long }];
  const line = arrange.post(f.rt, f.t.id, { kind: 'voice', text: voice, blockItemId: shown.id, answerTo, comments });
  const read = arrange.describeItem(f.rt, line, f.beta);
  assert.match(read, new RegExp(`read_message \\{ id: "${shown.id}" \\} has the rest`));
});
