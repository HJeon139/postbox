// The pure parts of tools/lint-ternary.mjs (#685): the nested ternaries in Biome’s report, which of them sit on an added
// line, and which files have more than at the base. The lines a diff adds are read by tools/diff-added-lines.mjs, tested
// in tests/diff-added-lines.test.mjs. Its runs against real git and Biome are in tests/process/lint-ternary.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFiles, countByPath, nestedTernaries, newHits, overlapsAdded, risenCounts } from '../tools/lint-ternary.mjs';

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

test('lint-ternary: git’s -z name-status gives each file’s path now and at the base, with none for an added one', () => {
  const listed = ['M', 'a b.mjs', 'A', 'new.mjs', 'R087', 'old.mjs', 'moved/new.mjs', ''].join('\0');
  assert.deepEqual(changedFiles(listed), [
    { path: 'a b.mjs', oldPath: 'a b.mjs' },
    { path: 'new.mjs', oldPath: '' },
    { path: 'moved/new.mjs', oldPath: 'old.mjs' },
  ]);
});

test('lint-ternary: a file fails when it has more hits than at the base, where a file missing from the base has none', () => {
  const before = countByPath([{ path: 'same.mjs' }, { path: 'same.mjs' }, { path: 'fewer.mjs' }]);
  const after = countByPath([{ path: 'same.mjs' }, { path: 'same.mjs' }, { path: 'more.mjs' }]);
  assert.deepEqual(risenCounts(['same.mjs', 'fewer.mjs', 'more.mjs'], before, after), [{ path: 'more.mjs', before: 0, after: 1 }]);
});
