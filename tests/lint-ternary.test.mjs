// The pure parts of tools/lint-ternary.mjs (#685): the nested ternaries in Biome’s report, which of them sit on an added
// line, the key a hit is matched by, and which hits the base doesn’t account for (#752). The lines a diff adds are read by tools/diff-added-lines.mjs, tested
// in tests/diff-added-lines.test.mjs. Its runs against real git and Biome are in tests/process/lint-ternary.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFiles, changedRanges, excessHits, hitKey, nestedTernaries, overlapsAdded } from '../tools/lint-ternary.mjs';

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

test('lint-ternary: a hit’s key is the trimmed text of its lines, so moving or reindenting it keeps it', () => {
  const lines = ['const a = 1;', '    return x ?', '\t  y ? 1 : 2', '  : 3;  '];
  assert.equal(hitKey(lines, { start: 2, end: 3 }), 'return x ?\ny ? 1 : 2');
  assert.equal(hitKey(['return x ? y ? 1 : 2 : 3;'], { start: 1, end: 1 }), hitKey(['      return x ? y ? 1 : 2 : 3;'], { start: 1, end: 1 }));
});

test('lint-ternary: a key fails only past its count at the base, over the whole change, with the excess on added lines first', () => {
  const now = [
    { path: 'a.mjs', key: 'k', added: true },
    { path: 'a.mjs', key: 'k', added: false },
    { path: 'b.mjs', key: 'moved', added: true },
    { path: 'c.mjs', key: 'new', added: false },
  ];
  const before = [{ key: 'k' }, { key: 'moved' }, { key: 'gone' }];
  assert.deepEqual(excessHits(before, now), [
    { path: 'c.mjs', key: 'new', added: false },
    { path: 'a.mjs', key: 'k', added: true },
  ]);
  assert.deepEqual(excessHits([], [{ key: 'x', added: true }]), [{ key: 'x', added: true }], 'none at the base');
});

test('lint-ternary: git’s -z name-status gives each file’s path now and at the base, with none for an added one', () => {
  const listed = ['M', 'a b.mjs', 'A', 'new.mjs', 'R087', 'old.mjs', 'moved/new.mjs', ''].join('\0');
  assert.deepEqual(changedFiles(listed), [
    { path: 'a b.mjs', oldPath: 'a b.mjs' },
    { path: 'new.mjs', oldPath: '' },
    { path: 'moved/new.mjs', oldPath: 'old.mjs' },
  ]);
});

test('lint-ternary: a diff the shared parser can’t read fails under lint-ternary’s name', () => {
  assert.throws(() => changedRanges('--- a/x.mjs\n+++ x.mjs\n'), /^Error: lint-ternary: can’t read git’s diff at line 2: the new file’s name has no “b\/”$/);
});
