// The pure parts of tools/lint-ternary.mjs (#685): the lines a diff adds, the nested ternaries in Biome’s report, and
// which of them sit on an added line. Its runs against real git and Biome are in tests/process/lint-ternary.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedRanges, nestedTernaries, newHits, overlapsAdded } from '../tools/lint-ternary.mjs';

test('lint-ternary: a hunk’s added lines come from its +start,count header, with a missing count meaning one', () => {
  const diff = `diff --git a/x.mjs b/x.mjs
--- a/x.mjs
+++ b/x.mjs
@@ -3 +3 @@ x
-old
+new
@@ -9,0 +10,3 @@
+a
+b
+c
`;
  assert.deepEqual(
    addedRanges(diff),
    new Map([
      [
        'x.mjs',
        [
          { start: 3, end: 3 },
          { start: 10, end: 12 },
        ],
      ],
    ]),
  );
});

test('lint-ternary: a hunk that only removes lines adds none, and a file with no added lines is left out', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -4,2 +3,0 @@', '-gone', '-gone too', ''].join('\n');
  assert.deepEqual(addedRanges(diff), new Map());
});

test('lint-ternary: a path with a space loses the tab git appends, and a quoted one is unquoted', () => {
  const diff = `--- /dev/null
+++ b/dir é/a b.mjs\t
@@ -0,0 +1 @@
+x
--- a/q.mjs
+++ "b/q\\"t\\303\\251.mjs"
@@ -1 +1,2 @@
-was
+y
+z
`;
  assert.deepEqual([...addedRanges(diff).keys()], ['dir é/a b.mjs', 'q"té.mjs']);
});

test('lint-ternary: a +++ line that names no new file fails, rather than dropping that file’s lines', () => {
  const diff = ['--- a/gone.mjs', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n');
  assert.throws(() => addedRanges(diff), /\+\+\+ \/dev\/null/);
});

test('lint-ternary: a hit counts when any line of its span is an added line, and not when it only borders one', () => {
  const added = [
    { start: 5, end: 5 },
    { start: 20, end: 22 },
  ];
  assert.equal(overlapsAdded(added, 5, 5), true, 'the one added line');
  assert.equal(overlapsAdded(added, 3, 6), true, 'a span over the added line');
  assert.equal(overlapsAdded(added, 22, 30), true, 'a span starting on the last added line');
  assert.equal(overlapsAdded(added, 18, 20), true, 'a span ending on the first added line');
  assert.equal(overlapsAdded(added, 4, 4), false, 'the line before');
  assert.equal(overlapsAdded(added, 6, 19), false, 'the lines between');
  assert.equal(overlapsAdded(added, 23, 23), false, 'the line after');
});

/** A Biome JSON report holding these diagnostics. */
const report = (diagnostics, notPrinted = 0) => ({ summary: { diagnosticsNotPrinted: notPrinted }, diagnostics, command: 'lint' });
const ternary = (path, start, end) => ({
  severity: 'info',
  category: 'lint/style/noNestedTernary',
  location: { path, start: { line: start, column: 1 }, end: { line: end, column: 9 } },
});

test('lint-ternary: Biome’s report gives each nested ternary’s path and its first and last lines', () => {
  assert.deepEqual(nestedTernaries(report([ternary('a.mjs', 3, 5)])), [{ path: 'a.mjs', start: 3, end: 5 }]);
});

test('lint-ternary: an error in Biome’s report, or diagnostics it left out, fails rather than passing as no hits', () => {
  const io = { severity: 'error', category: 'internalError/io', message: 'No such file', location: { path: 'a.mjs' } };
  assert.throws(() => nestedTernaries(report([io])), /internalError\/io/);
  assert.throws(() => nestedTernaries(report([], 3)), /3 diagnostics/);
});

test('lint-ternary: only hits on an added line of their own file are new', () => {
  const added = new Map([['a.mjs', [{ start: 4, end: 4 }]]]);
  const hits = [
    { path: 'a.mjs', start: 4, end: 4 },
    { path: 'a.mjs', start: 9, end: 9 },
    { path: 'b.mjs', start: 4, end: 4 },
  ];
  assert.deepEqual(newHits(hits, added), [{ path: 'a.mjs', start: 4, end: 4 }]);
});

test('lint-ternary: a removed line that reads “-- a/…” and an added one that reads “++ b/…” stay in their hunk', () => {
  // With -U0 they show as “--- a/other.mjs” and “+++ b/other.mjs”, which a parser that doesn’t count a hunk’s lines
  // takes for a new file’s header, moving the rest of x.mjs’s hunks to other.mjs.
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -2 +2 @@', '--- a/other.mjs', '+++ b/other.mjs', '@@ -24,0 +24 @@', '+late', ''].join('\n');
  assert.deepEqual(
    addedRanges(diff),
    new Map([
      [
        'x.mjs',
        [
          { start: 2, end: 2 },
          { start: 24, end: 24 },
        ],
      ],
    ]),
  );
});

test('lint-ternary: a hunk that says it has more lines than the diff holds fails, rather than reading on', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -1 +1,2 @@', '+only one', ''].join('\n');
  assert.throws(() => addedRanges(diff), /ends inside a hunk/);
});

test('lint-ternary: a diff cut off inside a hunk that only removes lines fails, rather than passing as no added lines', () => {
  assert.throws(() => addedRanges('--- a/x.mjs\n+++ b/x.mjs\n@@ -1,3 +0,0 @@\n-x'), /ends inside a hunk/);
});
