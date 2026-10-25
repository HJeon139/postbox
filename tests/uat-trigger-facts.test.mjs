import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cell } from '../tools/uat/trigger-facts.mjs';

/** A table row’s cells as GitHub reads them: split on each pipe that an odd run of backslashes doesn’t escape. */
const cellsOf = (row) => row.split(/(?<!(?:^|[^\\])(?:\\\\)*\\)\|/).slice(1, -1);

test('#346: a cell with a backslash before a pipe stays one cell in the UAT report’s table', () => {
  const evidence = String.raw`grep -E 'a\|b' failed`;
  assert.equal(cellsOf(`| ${cell(evidence)} | next |`).length, 2);
  assert.equal(cellsOf(`| ${cell(String.raw`C:\dir\ `)} | next |`).length, 2);
  assert.equal(cell('two\nlines'), 'two lines');
});
