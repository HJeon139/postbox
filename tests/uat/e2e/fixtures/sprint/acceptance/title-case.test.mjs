import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleCase } from '../src/title-case.mjs';

test('titleCase capitalizes each word', () => {
  assert.equal(titleCase('hello world'), 'Hello World');
});

test('titleCase leaves small words lowercase, except the first and the last', () => {
  assert.equal(titleCase('the tale of a cat and the hat'), 'The Tale of a Cat and the Hat');
  assert.equal(titleCase('what it is for'), 'What It Is For');
});

test('titleCase keeps a word that is already all capitals', () => {
  assert.equal(titleCase('a guide to the NASA archive'), 'A Guide to the NASA Archive');
});
