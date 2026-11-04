// The one parser of git’s `-U0` diffs (tools/diff-added-lines.mjs), which the commit privacy scan (#508) reads each
// commit’s added lines with, and lint-ternary (#685) its change’s added line ranges. The diffs are copied from git’s
// output (tests/diff-fixture.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedRanges, parseAddedLines } from '../tools/diff-added-lines.mjs';
import { diff, newBinary, newFile, removedLine } from './diff-fixture.mjs';

// A made-up home path, built here so this file doesn’t hold one for the tree’s own privacy check to flag.
const HOME_PATH = ['', 'Users', 'alice', 'x'].join('/');

test('the added lines are grouped by the file they were added to, and removed lines are left out', () => {
  const text = diff(newFile('a.txt', ['one', 'two']), removedLine('b.txt', 'gone'), newFile('c.txt', ['three']));
  const { files } = parseAddedLines(text);
  assert.deepEqual(
    [...files],
    [
      ['a.txt', ['one', 'two']],
      ['c.txt', ['three']],
    ],
  );
});

test('a content line that starts with “++ b/” is an added line, not the header of another file', () => {
  const text = diff(newFile('a.txt', ['++ b/other.txt', `++ ${HOME_PATH}`]));
  const { files } = parseAddedLines(text);
  assert.deepEqual([...files], [['a.txt', ['++ b/other.txt', `++ ${HOME_PATH}`]]]);
});

test('a line after a hunk’s counted lines is read as a header again', () => {
  const text = diff(newFile('a.txt', ['one']), newFile('b.txt', ['two']));
  const { files } = parseAddedLines(text);
  assert.deepEqual([...files.keys()], ['a.txt', 'b.txt']);
});

test('“No newline at end of file” isn’t counted as one of a hunk’s lines', () => {
  const text = diff(newFile('a.txt', ['one']), '\\ No newline at end of file', newFile('b.txt', ['two']));
  const { files } = parseAddedLines(text);
  assert.deepEqual(
    [...files],
    [
      ['a.txt', ['one']],
      ['b.txt', ['two']],
    ],
  );
});

test('a binary file is counted as skipped and adds no lines', () => {
  const { files, binary } = parseAddedLines(diff(newBinary('b.bin'), newFile('a.txt', ['one'])));
  assert.deepEqual([...files.keys()], ['a.txt']);
  assert.equal(binary, 1);
});

test('a rename with no changed lines adds no lines', () => {
  const text = diff(['diff --git a/a.txt b/c.txt', 'similarity index 100%', 'rename from a.txt', 'rename to c.txt']);
  const { files } = parseAddedLines(text);
  assert.equal(files.size, 0);
});

test('a path git quotes is read back as the file’s own name', () => {
  const quoted = (written) => diff(['diff --git x y', '--- /dev/null', `+++ ${written}`, '@@ -0,0 +1 @@', '+one']);
  assert.deepEqual([...parseAddedLines(quoted('"b/odd\\"name.txt"')).files.keys()], ['odd"name.txt']);
  assert.deepEqual([...parseAddedLines(quoted('"b/caf\\303\\251.txt"')).files.keys()], ['café.txt']);
  assert.deepEqual([...parseAddedLines(quoted('b/with space.txt\t')).files.keys()], ['with space.txt']);
});

test('a line git’s diff format doesn’t have, outside a hunk, is an error rather than skipped', () => {
  assert.throws(() => parseAddedLines(diff(['diff --cc a.txt', '@@@ -1,1 -1,1 +1,2 @@@'])), /can’t read git’s diff at line 1/);
  assert.throws(() => parseAddedLines(diff(newFile('a.txt', ['one']), 'surprise')), /can’t read git’s diff at line 8/);
});

test('a diff that ends inside a hunk is an error, not a commit that adds fewer lines', () => {
  const cut = diff(['diff --git a/a.txt b/a.txt', '--- /dev/null', '+++ b/a.txt', '@@ -0,0 +1,2 @@', '+one']);
  assert.throws(() => parseAddedLines(cut), /it ends inside a hunk/);
});

test('the notes `git show --remerge-diff` writes in a merge’s file headers are read past', () => {
  const text = diff(
    ['diff --git a/c.txt b/c.txt', 'remerge CONFLICT (content): Merge conflict in c.txt', 'index ed2f78b..53c74cd 100644'],
    ['--- a/c.txt', '+++ b/c.txt', '@@ -1,3 +1 @@', '-<<<<<<< 215b818 (w)', '-=======', '->>>>>>> 8c2a855 (side)', '+evil'],
    ['diff --git a/k2.txt b/k2.txt', 'remerge CONFLICT (rename/delete): keep.txt renamed to k2.txt in 8c2a855 (side)'],
    newFile('d.txt', ['two']),
  );
  assert.deepEqual(
    [...parseAddedLines(text).files],
    [
      ['c.txt', ['evil']],
      ['d.txt', ['two']],
    ],
  );
});

test('a note like remerge-diff’s, outside a file’s header, is an error rather than skipped', () => {
  const text = diff(newFile('a.txt', ['one']), 'remerge CONFLICT (content): Merge conflict in a.txt');
  assert.throws(() => parseAddedLines(text), /can’t read git’s diff at line 8/);
});

test('addedRanges: a hunk’s added lines come from its +start,count header, with a missing count meaning one', () => {
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

test('addedRanges: a hunk that only removes lines adds none, and a file with no added lines is left out', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -4,2 +3,0 @@', '-gone', '-gone too', ''].join('\n');
  assert.deepEqual(addedRanges(diff), new Map());
});

test('addedRanges: a path with a space loses the tab git appends, and a quoted one is unquoted', () => {
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

test('addedRanges: a +++ line that names no new file fails, rather than dropping that file’s lines', () => {
  const diff = ['--- a/gone.mjs', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n');
  assert.throws(() => addedRanges(diff), /\+\+\+ \/dev\/null/);
});

test('addedRanges: a removed line that reads “-- a/…” and an added one that reads “++ b/…” stay in their hunk', () => {
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

test('addedRanges: a hunk that says it has more lines than the diff holds fails, rather than reading on', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -1 +1,2 @@', '+only one', ''].join('\n');
  assert.throws(() => addedRanges(diff), /ends inside a hunk/);
});

test('addedRanges: a diff cut off inside a hunk that only removes lines fails, rather than passing as no added lines', () => {
  assert.throws(() => addedRanges('--- a/x.mjs\n+++ b/x.mjs\n@@ -1,3 +0,0 @@\n-x'), /ends inside a hunk/);
});

test('addedRanges: a line in a hunk that fits neither of its counts fails, rather than being skipped', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -1 +1 @@', ' context', '-old', '+new', ''].join('\n');
  assert.throws(() => addedRanges(diff), /doesn’t fit its hunk’s counts/);
});

test('addedRanges: a line git’s diff format doesn’t have, outside a hunk, fails rather than being skipped', () => {
  const diff = ['--- a/x.mjs', '+++ b/x.mjs', '@@ -1 +1 @@', '-old', '+new', 'surprise', ''].join('\n');
  assert.throws(() => addedRanges(diff), /can’t read git’s diff at line 6/);
});

test('addedRanges: a binary file and a merge’s remerge notes add no range, and “No newline” isn’t a line', () => {
  const text = diff(
    newBinary('b.bin'),
    ['diff --git a/c.mjs b/c.mjs', 'remerge CONFLICT (content): Merge conflict in c.mjs', '--- a/c.mjs', '+++ b/c.mjs'],
    ['@@ -2 +2 @@', '-was', '\\ No newline at end of file', '+now', '\\ No newline at end of file'],
  );
  assert.deepEqual(addedRanges(text), new Map([['c.mjs', [{ start: 2, end: 2 }]]]));
});

test('the added lines and their ranges come from the same read: as many lines as the ranges span, by file', () => {
  const text = diff(newFile('a.mjs', ['one', 'two']), removedLine('b.mjs', 'gone'), newFile('c.mjs', ['three']));
  const spans = [...addedRanges(text)].map(([path, ranges]) => [path, ranges.reduce((n, r) => n + r.end - r.start + 1, 0)]);
  const lines = [...parseAddedLines(text).files].map(([path, added]) => [path, added.length]);
  assert.deepEqual(spans, lines);
  assert.deepEqual(spans, [
    ['a.mjs', 2],
    ['c.mjs', 1],
  ]);
});

test('a removed line after its hunk’s removed count is spent fails, though the hunk still has an added line left', () => {
  const text = diff(['diff --git a/x.mjs b/x.mjs', '--- a/x.mjs', '+++ b/x.mjs', '@@ -0,0 +1,2 @@', '+a', '-x'], newFile('y.mjs', ['b']));
  assert.throws(() => parseAddedLines(text), /can’t read git’s diff at line 6: it doesn’t fit its hunk’s counts/);
});

test('a file’s hunk with no “+++ ” line before it fails, rather than counting for the file before it or for none', () => {
  const unnamed = (/** @type {string[]} */ hunk) => diff(newFile('a.mjs', ['one']), ['diff --git a/b.mjs b/b.mjs', 'index 814f4a4..e69de29 100644', ...hunk]);
  assert.throws(() => parseAddedLines(unnamed(['@@ -0,0 +1 @@', '+two'])), /can’t read git’s diff at line 10: a hunk before its file’s “\+\+\+ ” line/);
  assert.throws(() => addedRanges(unnamed(['@@ -1 +0,0 @@', '-gone'])), /can’t read git’s diff at line 10: a hunk before its file’s “\+\+\+ ” line/);
});
