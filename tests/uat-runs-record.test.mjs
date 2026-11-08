// What readRun keeps of a run’s run.json (tools/uat/runs.mjs): a recheck reads its phases and start phase from the
// record (tools/uat/recheck.mjs, recordedPhases and startPhase), and rewrites run.json from it, so a field the record
// drops is lost from the run as well as ignored by the recheck.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordedPhases } from '../tools/uat/phases.mjs';
import { readRun, runRecord } from '../tools/uat/runs.mjs';

/** A finished run’s folder with this run.json. @param {any} t @param {Record<string, unknown>} saved */
function runDir(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'uat-runs-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [], timeline: [] }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(saved));
  return dir;
}

test('a run’s record keeps the --phases it played, so a recheck checks only those', (t) => {
  const record = readRun(runDir(t, { scenario: 'remotehosts', phases: [4] }));
  assert.deepEqual(record?.phases, [4]);
  assert.deepEqual(recordedPhases(record), [4]);
});

test('a run’s record keeps its start phase, step cap and title', (t) => {
  const record = readRun(runDir(t, { scenario: 'remotehosts', startPhase: 2, stepCap: 8, title: 'Remote hosts' }));
  assert.equal(record?.startPhase, 2);
  assert.equal(record?.stepCap, 8);
  assert.equal(record?.title, 'Remote hosts');
});

test('a run from before these fields reads them as unset, as before', (t) => {
  const record = readRun(runDir(t, { scenario: 'remotehosts' }));
  assert.equal(record?.phases, null);
  assert.equal(recordedPhases(record), null);
  assert.equal(record?.startPhase, null);
});

test('a run’s record keeps every key the live run writes to run.json, as it wrote it', (t) => {
  const dir = runDir(t, {});
  const scenario = { title: 'Remote hosts', phases: [{ title: 'One' }] };
  const written = {
    ...runRecord({
      root: process.cwd(),
      dir,
      scenario,
      name: 'remotehosts',
      opt: { 'agent-model': 'm', 'agent-effort': 'low', 'tester-model': 't' },
      started: 0,
      steps: 3,
      cap: 8,
      startPhase: 2,
      phases: [4],
      tester: { spent: 0.05 },
      facts: { streams: [], timing: { total: 1 } },
      coverage: [{ phase: 1, trigger: 'x', hit: true }],
      now: 120_000,
      git: () => null,
    }),
    // What tools/uat-run.mjs adds beside runRecord’s keys.
    telemetry: { report: 'rep_1' },
    budget: { cap: 15 },
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(written));
  const record = /** @type {Record<string, unknown>} */ (readRun(dir));
  for (const [key, value] of Object.entries(written)) assert.deepEqual(record[key], value, `run.json’s ${key}`);
});

test('#995 a run’s record keeps whether the agent drew first and its pair of answers, which only the live run records', (t) => {
  const picture = { expects: 'picture', first: 'app', inputsBefore: 0, met: true };
  const sideBySide = { pick: 'words', pictureAs: 'B', why: 'Shorter to act on.' };
  const record = readRun(runDir(t, { scenario: 'everyday-subs-cancel', picture, sideBySide, pictureJudges: { usd: 0.3 } }));
  assert.deepEqual(record?.picture, picture);
  assert.deepEqual(record?.sideBySide, sideBySide);
  assert.deepEqual(record?.pictureJudges, { usd: 0.3 });
  assert.equal('sideBySide' in (readRun(runDir(t, { scenario: 'delivery' })) ?? {}), false, 'a run without one gets none');
});
