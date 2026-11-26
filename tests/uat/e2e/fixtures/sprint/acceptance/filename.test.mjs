import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filename } from '../src/filename.mjs';

test('filename is the title’s slug with its extension', () => {
  assert.equal(filename('Hello, World', 'md'), 'hello-world.md');
});

test('filename keeps the slug to 40 characters, cut at a word, with no ellipsis', () => {
  const name = filename('The quick brown fox jumps over the lazy dog again and again', 'md');
  assert.equal(name, 'the-quick-brown-fox-jumps-over-the-lazy.md');
});

test('filename of an empty title is untitled', () => {
  assert.equal(filename('', 'txt'), 'untitled.txt');
});
