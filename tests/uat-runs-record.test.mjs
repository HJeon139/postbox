// What readRun keeps of a run’s run.json (tools/uat/runs.mjs): a recheck reads its phases and start phase from the
// record (tools/uat/recheck.mjs, recordedPhases and startPhase), and rewrites run.json from it, so a field the record
// drops is lost from the run as well as ignored by the recheck.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordedPhases } from '../tools/uat/phases.mjs';
import { readRun } from '../tools/uat/runs.mjs';

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
