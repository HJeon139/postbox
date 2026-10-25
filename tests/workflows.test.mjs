import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../.github/workflows/', import.meta.url);

/** Lines that call a status function outside an `if:`. GitHub allows them only there; anywhere else the whole
 * workflow is invalid, and no run of it starts (#391 did this to the prompt gate). */
const misplacedStatus = (text) =>
  text
    .split('\n')
    .map((line, i) => ({ line: line.replace(/(^|\s)#.*$/, ''), n: i + 1 }))
    .filter(({ line }) => /\b(?:success|failure|cancelled|always)\(\)/.test(line) && !/^\s*(?:-\s+)?if:/.test(line))
    .map(({ n }) => n);

test('a workflow calls success(), failure(), cancelled() and always() only in an if', () => {
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.yml'))) {
    assert.deepEqual(misplacedStatus(readFileSync(new URL(name, DIR), 'utf8')), [], name);
  }
});

test('the status-function check catches one in a step’s env', () => {
  const broken = ['    if: always()', '      - if: cancelled()', '        env:', `          CANCELLED: \${{ cancelled() }}`];
  assert.deepEqual(misplacedStatus(broken.join('\n')), [4]);
});
