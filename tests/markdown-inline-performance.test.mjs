// Malformed link and image targets must not rescan the rest of the line from every opening parenthesis (#260).

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { rawHtmlProblems } from '../server/checks.mjs';
import { mapCodeSpans } from '../shared/code-spans.mjs';
import { inline } from '../shared/markdown-inline.mjs';
import { parseMentions } from '../shared/text.mjs';

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

test('an escaped backslash before a LaTeX closer stays text, not a malformed formula', () => {
  assert.equal(inline(String.raw`\(a\\)`, {}), String.raw`(a\)`);
  assert.equal(inline(String.raw`\[a\\]`, {}), String.raw`[a\]`);
});

test('#1659 a line with a pipe over 80,000 spaces and a non-separator runs in under 200 ms across mapCodeSpans, parseMentions and rawHtmlProblems', () => {
  const source = `@bob | \`code\`\n${' '.repeat(80_000)}x`;
  const started = performance.now();
  const mapped = mapCodeSpans(source, (c) => c);
  const mentions = parseMentions(source, ['bob']);
  const html = rawHtmlProblems(source);
  const elapsed = performance.now() - started;
  assert.equal(mapped.startsWith('@bob | code\n'), true);
  assert.deepEqual(mentions, ['bob']);
  assert.deepEqual(html, []);
  assert.ok(elapsed < 200, `table separator check took ${Math.round(elapsed)} ms`);
});
