// Malformed link and image targets must not rescan the rest of the line from every opening parenthesis (#260).

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { inline } from '../shared/markdown-inline.mjs';

test('forty thousand unclosed image targets render in under one second', () => {
  const source = '![a]('.repeat(40_000);
  const started = performance.now();
  const rendered = inline(source, {});
  const elapsed = performance.now() - started;

  assert.equal(rendered, source);
  assert.ok(elapsed < 1_000, `rendering took ${Math.round(elapsed)} ms`);
});

test('sixty-six thousand unclosed LaTeX math delimiters render in under one second', () => {
  const source = '\\(a'.repeat(66_667);
  const started = performance.now();
  const rendered = inline(source, {});
  const elapsed = performance.now() - started;

  assert.equal(rendered, '(a'.repeat(66_667));
  assert.ok(elapsed < 1_000, `rendering took ${Math.round(elapsed)} ms`);
});
