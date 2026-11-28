// #482: run.json records the runner’s exit code (tools/uat/run-exit.mjs), on a normal exit and on a stop by the budget
// or the run’s bound, which end through the report as a normal exit does. The hostwakes run of 27 October 2026 was
// started detached, and its run.json had no exit field.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunBudget } from '../tools/uat/budget.mjs';
import { RunBound } from '../tools/uat/run-bound.mjs';
import { exitWhenSettled, runExit } from '../tools/uat/run-exit.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A run folder with the run.json a run writes before it exits. @param {Record<string, unknown>} [record] */
function runFolder(record = {}) {
  const dir = tempDir('uat-run-exit-');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run: 'r1', scenario: 'hostwakes', steps: 4, ...record }));
  return dir;
}
const runJson = (/** @type {string} */ dir) => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));

test('a run that ends normally records exit 0 in run.json, keeping what was there', () => {
  const dir = runFolder();
  assert.equal(runExit(dir, { findings: [], exitCode: 0 }), 0);
  assert.deepEqual(runJson(dir), { run: 'r1', scenario: 'hostwakes', steps: 4, exit: 0 });
});

test('a run stopped by its budget records its exit code beside where the budget stopped it', () => {
  const budget = new RunBudget({ cap: 5, testerShare: 1, agentsShare: 3, now: () => 1000 });
  budget.stop(3, false, 'the next step and a turn it may start would pass the cap.');
  const dir = runFolder({ budget: budget.summary() });
  assert.equal(runExit(dir, { findings: [], exitCode: 0 }), 0);
  const record = runJson(dir);
  assert.equal(record.exit, 0);
  assert.equal(record.budget.stopped.step, 3, 'the budget’s record is kept');
});

test('a run stopped by its bound, whose findings fail it, records exit 1', () => {
  const bound = new RunBound({ maxTurns: 2, maxMinutes: 45, now: () => 0 });
  bound.stop('its agents started 2 turns, the most --max-turns 2 allows.');
  const dir = runFolder({ bound: bound.summary() });
  const findings = [{ check: 'postbox-output', title: 'Postbox printed an error' }];
  assert.equal(runExit(dir, { findings, exitCode: 0 }), 1);
  assert.equal(runJson(dir).exit, 1);
  assert.ok(runJson(dir).bound.stopped, 'the bound’s record is kept');
});

test('a run that failed after writing run.json records exit 1, and a signal’s 130 stands', () => {
  const failed = runFolder();
  assert.equal(runExit(failed, { failed: true, exitCode: 0 }), 1);
  assert.equal(runJson(failed).exit, 1);
  const signaled = runFolder();
  assert.equal(runExit(signaled, { findings: [], exitCode: 130 }), 130);
  assert.equal(runJson(signaled).exit, 130);
});

test('a run that ended before writing run.json gets none, and a recheck (no folder) records nothing', (t) => {
  const said = t.mock.method(console, 'error', () => {});
  const dir = tempDir('uat-run-exit-');
  assert.equal(runExit(dir, { failed: true, exitCode: 0 }), 1);
  assert.equal(existsSync(join(dir, 'run.json')), false, 'no run.json was made');
  assert.equal(said.mock.callCount(), 0, 'and nothing went wrong to say');
  assert.equal(runExit(null, { findings: [], exitCode: 0 }), 0);
});

test('a run.json that can’t be read keeps the exit code, and isn’t overwritten', (t) => {
  const dir = tempDir('uat-run-exit-');
  writeFileSync(join(dir, 'run.json'), '{ torn');
  const said = [];
  t.mock.method(console, 'error', (/** @type {string} */ line) => said.push(line));
  assert.equal(runExit(dir, { findings: [], exitCode: 0 }), 0);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), '{ torn', 'left as it was');
  assert.match(said.join('\n'), /Couldn’t record the exit code in run\.json/);
});

/** What exitWhenSettled set and said, with process.exitCode left alone. */
const io = () => {
  const seen = { code: /** @type {number | null} */ (null), exited: /** @type {number | null} */ (null), said: /** @type {string[]} */ ([]) };
  return {
    seen,
    io: {
      setCode: (c) => {
        seen.code = c;
      },
      exit: (c) => {
        seen.exited = c;
      },
      say: (l) => seen.said.push(l),
    },
  };
};

test('the runner’s exit, once its run ends, is the findings’ code, and run.json in the run’s folder records it', async () => {
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const dir = runFolder();
    const { seen, io: o } = io();
    await exitWhenSettled(Promise.resolve([]), () => dir, o);
    assert.deepEqual([seen.code, seen.exited, runJson(dir).exit], [0, null, 0]);
    const failing = runFolder();
    const out = io();
    await exitWhenSettled(Promise.resolve([{ check: 'postbox-output', key: 'k' }]), () => failing, out.io);
    assert.deepEqual([out.seen.code, runJson(failing).exit], [1, 1], 'a finding that fails the run');
  } finally {
    process.exitCode = saved;
  }
});

test('a run that throws exits 1, says why, and records 1; a recheck, with no folder, records nothing', async () => {
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const dir = runFolder();
    const { seen, io: o } = io();
    await exitWhenSettled(Promise.reject(new Error('the page went away')), () => dir, o);
    assert.deepEqual([seen.exited, runJson(dir).exit], [1, 1]);
    assert.match(seen.said.join('\n'), /UAT run failed: .*the page went away/);
    const none = io();
    await exitWhenSettled(Promise.resolve([]), () => null, none.io);
    assert.equal(none.seen.code, 0);
  } finally {
    process.exitCode = saved;
  }
});

test('the runner settles main() through exitWhenSettled with the folder it planned', () => {
  const runner = readFileSync(new URL('../tools/uat-run.mjs', import.meta.url), 'utf8');
  assert.match(runner, /Promise\.resolve\(\)\.then\(\(\) => main\(\(plan = planRun\(\)\)\)\)/, 'a plan that throws fails as a run does');
  assert.match(runner, /exitWhenSettled\(run, \(\) => plan\?\.dir \?\? null\)/);
  assert.match(runner, /stepHolds\(\{ goals, log, timeline \}\)/, 'and gives stepHolds the run’s timeline');
  assert.match(runner, /async function main\(\{[^}]*\bdir \}\)/, 'main() runs in the folder the plan named, where run.json gets its exit');
  assert.equal(runner.match(/runsRoot\(/g)?.length, 1, 'and the run’s folder is named once, in planRun');
});
