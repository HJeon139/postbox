import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncate } from '../src/truncate.mjs';

test('truncate leaves a title that fits as it is', () => {
  assert.equal(truncate('Hello World', 20), 'Hello World');
});

test('truncate cuts at a word and ends with an ellipsis, within the limit', () => {
  assert.equal(truncate('The quick brown fox jumps', 16), 'The quick brown…');
  assert.ok(truncate('The quick brown fox jumps', 16).length <= 16);
});

test('truncate cuts inside a first word that is longer than the limit', () => {
  assert.equal(truncate('Supercalifragilistic', 8), 'Superca…');
});
