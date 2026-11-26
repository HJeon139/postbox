import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const DIR = new URL('../.github/workflows/', import.meta.url);
const ACTIONS = new URL('../.github/actions/', import.meta.url);

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

test('so does each local action the workflows use', () => {
  const actions = readdirSync(ACTIONS, { recursive: true }).filter((f) => /(^|\/)action\.ya?ml$/.test(String(f)));
  assert.ok(actions.length > 0, 'the local actions are found');
  for (const name of actions) assert.deepEqual(misplacedStatus(readFileSync(new URL(String(name), ACTIONS), 'utf8')), [], String(name));
});

test('the status-function check catches one in a step’s env', () => {
  const broken = ['    if: always()', '      - if: cancelled()', '        env:', `          CANCELLED: \${{ cancelled() }}`];
  assert.deepEqual(misplacedStatus(broken.join('\n')), [4]);
});

/** The workflows whose checks the protect-main ruleset requires. GitHub’s merge queue waits for each of them on every
 * merge group, so a workflow that doesn’t run on merge_group holds the queue until its timeout. */
const REQUIRED = ['check.yml', 'dependency-review.yml'];

test('the workflows of the required checks run on merge groups', () => {
  for (const name of REQUIRED) {
    assert.match(readFileSync(new URL(name, DIR), 'utf8'), /^ {2}merge_group:/m, name);
  }
});

test('a workflow that runs on merge groups gives each its own concurrency group', () => {
  // A merge group has no pull request number: a group keyed on it alone is the same for every merge group, and
  // cancel-in-progress would cancel one with the next.
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(new URL(name, DIR), 'utf8');
    if (!/^ {2}merge_group:/m.test(text)) continue;
    const group = text.match(/^ {2}group: (.*)$/m)?.[1] ?? '';
    assert.ok(!group.includes('pull_request.number') || group.includes('||'), `${name}: ${group}`);
  }
});
