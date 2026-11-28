// How the Model field reads what Postbox kept of each model’s last turn (#1977, shared/model-ran.mjs): the order of
// its suggestions, the model it fills in, and its words. The owner met a first suggestion that was refused, and then
// another, on a host whose harness listed 13 models.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byRan, ranDefault, ranWords } from '../shared/model-ran.mjs';

const LISTED = ['opus-new', 'sonnet', 'haiku', 'opus-old'];
/** @type {Record<string, import('../shared/model-ran.mjs').ModelRun>} */
const RAN = {
  'opus-new': { ended: 'failed', at: 50, why: '403 opus-new is not available for this account' },
  sonnet: { ended: 'answered', at: 40 },
  'typed-by-hand': { ended: 'answered', at: 45 },
  haiku: { ended: 'failed', at: 30 },
};

test('suggestions: the models that answered first, newest first and a typed one among them, then the untried, then the failed', () => {
  assert.deepEqual(byRan(LISTED, RAN), ['typed-by-hand', 'sonnet', 'opus-old', 'opus-new', 'haiku']);
});

test('with nothing kept the list is the harness’s own, in its order, and no model is ever left out', () => {
  for (const ran of [null, undefined, {}]) assert.deepEqual(byRan(LISTED, ran), LISTED);
  assert.deepEqual([...byRan(LISTED, RAN)].sort(), [...LISTED, 'typed-by-hand'].sort());
  // A model whose every turn failed is still suggested, last.
  assert.deepEqual(byRan(['a', 'b'], { a: { ended: 'failed', at: 1 } }), ['b', 'a']);
});

test('the model Postbox fills in is the one that answered last, and none when none has', () => {
  assert.equal(ranDefault(RAN), 'typed-by-hand');
  assert.equal(ranDefault({ 'opus-new': RAN['opus-new'] }), null);
  assert.equal(ranDefault(null), null);
});

test('the words say what a past turn did, with the harness’s reason, and never that a model works', () => {
  const said = { where: 'on build-box', when: '5 minutes ago' };
  assert.equal(ranWords(RAN.sonnet, said), 'This model’s last turn on build-box answered, 5 minutes ago.');
  assert.equal(
    ranWords(RAN['opus-new'], said),
    'This model’s last turn on build-box failed before its first step, 5 minutes ago: 403 opus-new is not available for this account. It may run now: Postbox doesn’t know until a turn tries.',
  );
  assert.equal(
    ranWords(RAN.haiku, { where: 'here', when: 'just now' }),
    'This model’s last turn here failed before its first step, just now. It may run now: Postbox doesn’t know until a turn tries.',
  );
  // Words that end a sentence already aren’t given a second full stop.
  assert.match(String(ranWords({ ended: 'failed', at: 1, why: 'Sign in again. ' }, said)), /ago: Sign in again\. It may run now/);
  assert.equal(ranWords(undefined, said), null);
  for (const words of [ranWords(RAN.sonnet, said), ranWords(RAN.haiku, said)]) assert.doesNotMatch(String(words), /\bworks\b/);
});
