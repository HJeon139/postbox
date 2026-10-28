import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLIMPSE_CHARS, GLIMPSE_SOURCE_CHARS } from '../shared/limits.mjs';
import { appendGlimpseSource, glimpseOf } from '../shared/text.mjs';

test('#478 a long thinking stream keeps its latest whole sentences within the glimpse bound', () => {
  const old = 'This earlier investigation no longer belongs in the working row. '.repeat(8);
  const latest = 'The implementation now passes its focused checks. I am reading the final report before review.';
  const glimpse = glimpseOf(old + latest);

  assert.equal(glimpse, latest);
  assert.ok(glimpse.length <= GLIMPSE_CHARS);
  assert.ok(!glimpse.startsWith('…'));
  assert.ok(!glimpse.endsWith('…'));
  assert.equal(glimpseOf(`${'Discarded sentence. '.repeat(GLIMPSE_SOURCE_CHARS)}${latest}`), latest, 'only the bounded tail affects the result');
});

test('#478 streamed pieces keep spaces and sentence boundaries before making a glimpse', () => {
  let source = '';
  for (const piece of ['I read the file. ', 'Next I check', ' the tests.', ' Done.']) source = appendGlimpseSource(source, piece);

  assert.equal(source, 'I read the file. Next I check the tests. Done.');
  assert.equal(glimpseOf(source), 'Next I check the tests. Done.');
});

test('#478 an overlong latest sentence stops at a whole word without an ellipsis', () => {
  const glimpse = glimpseOf(`The ${'carefully '.repeat(40)}written conclusion is ready.`);

  assert.ok(glimpse.length <= GLIMPSE_CHARS);
  assert.match(glimpse, /^The carefully /);
  assert.doesNotMatch(glimpse, /\s$/);
  assert.doesNotMatch(glimpse, /…/);
  assert.equal(glimpseOf('x'.repeat(GLIMPSE_CHARS + 1)), '', 'one overlong word is not cut into a fragment');
});
