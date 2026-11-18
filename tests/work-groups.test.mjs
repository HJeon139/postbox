// #1446: a file to review goes to the top of the Work pane’s Files (shared/work-groups.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileGroups } from '../shared/work-groups.mjs';

const file = (id, state, lastAt, flag = false) => ({ id, state, lastAt, flag });
const groups = (files) =>
  fileGroups(
    files,
    (f) => f.state,
    (f) => f.flag,
  ).map((g) => [g.state, g.files.map((f) => f.id)]);

test('without a flagged file, groups go uncommitted, committed, pushed, outside, newest first in each', () => {
  assert.deepEqual(groups([file('a', 'pushed', 1), file('b', 'uncommitted', 1), file('c', 'uncommitted', 2)]), [
    ['uncommitted', ['c', 'b']],
    ['pushed', ['a']],
  ]);
});

test('a flagged file is first in Files: its group leads, and it leads its group, however old', () => {
  const list = groups([file('new', 'uncommitted', 9), file('old', 'committed', 1, true), file('other', 'committed', 5)]);
  assert.deepEqual(list, [
    ['committed', ['old', 'other']],
    ['uncommitted', ['new']],
  ]);
});
