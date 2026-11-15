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
