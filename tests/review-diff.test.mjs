import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followLines } from '../shared/review-diff.mjs';

const v1 = ['# Plan', '', 'We ship on Friday after the review.', 'Then we rest.'].join('\n');

test('#123: a line comment follows its line, and one on a changed line moves, marked', () => {
  const v2 = ['# Plan', '', 'Added a line.', 'We ship on Friday after the review.', 'Then we sleep.'].join('\n');
  assert.deepEqual(followLines([{ line: 3, text: 'When?' }], v1, v2), [{ line: 4, text: 'When?' }]);
  assert.deepEqual(followLines([{ line: 4, text: 'Rest how?' }], v1, v2), [{ line: 5, text: 'Rest how?', moved: true }]);
});

test('#179: after a revision, a comment whose quote is still there stays on it, even where its line changed', () => {
  const c = { line: 3, col: 12, endLine: 3, endCol: 17, quote: 'Friday', text: 'Which Friday?' };
  // The line moved down and changed around the quote.
  const v2 = ['# Plan', '', 'Intro.', 'We now ship on Friday, after review.', 'Then we rest.'].join('\n');
  assert.deepEqual(followLines([c], v1, v2), [{ ...c, line: 4, col: 16, endLine: 4, endCol: 21 }]);
});

test('#179: when the quote is there twice, the comment goes to the one nearest its line', () => {
  const c = { line: 4, col: 9, endLine: 4, endCol: 12, quote: 'rest', text: 'Rest more.' };
  const v2 = ['# Plan', 'We rest first.', '', 'We ship on Friday after the review.', 'Then we rest well.'].join('\n');
  assert.deepEqual(followLines([c], v1, v2)[0], { ...c, line: 5, col: 9, endLine: 5, endCol: 12 });
});

test('#179: when the quote is gone, the comment says its text changed and stays on that line', () => {
  const c = { line: 3, col: 12, endLine: 3, endCol: 17, quote: 'Friday', text: 'Which Friday?' };
  const v2 = ['# Plan', '', 'We ship on Monday after the review.', 'Then we rest.'].join('\n');
  assert.deepEqual(followLines([c], v1, v2), [{ line: 3, text: 'Which Friday?', moved: true, gone: 'Friday' }]);
});

test('#179: a quote across lines follows to its new lines', () => {
  const c = { line: 3, col: 29, endLine: 4, endCol: 4, quote: 'review.\nThen', text: 'Join these.' };
  const v2 = ['Top.', ...v1.split('\n')].join('\n');
  assert.deepEqual(followLines([c], v1, v2)[0], { ...c, line: 4, endLine: 5 });
});
