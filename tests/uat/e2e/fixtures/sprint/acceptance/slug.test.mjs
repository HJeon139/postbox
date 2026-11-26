import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slug } from '../src/slug.mjs';

test('slug joins a title’s words in lowercase with hyphens', () => {
  assert.equal(slug('Hello, World: a tale'), 'hello-world-a-tale');
});

test('slug never starts, ends or doubles a hyphen', () => {
  assert.equal(slug('  -- Hello --  World -- '), 'hello-world');
});

test('slug drops apostrophes and keeps digits', () => {
  assert.equal(slug("It's 2026 already"), 'its-2026-already');
});

test('slug of an empty title is untitled', () => {
  assert.equal(slug(''), 'untitled');
});
