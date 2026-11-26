import assert from 'node:assert/strict';
import { test } from 'node:test';
import { words } from '../src/words.mjs';

test('words splits a title on spaces and punctuation', () => {
  assert.deepEqual(words('Hello, World: a tale'), ['Hello', 'World', 'a', 'tale']);
});

test('words keeps digits and apostrophes inside a word', () => {
  assert.deepEqual(words("It's 2026 already"), ["It's", '2026', 'already']);
});

test('words of an empty or blank title is none', () => {
  assert.deepEqual(words(''), []);
  assert.deepEqual(words('  — … '), []);
});
