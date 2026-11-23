// Where a run stopped at its bound (tools/uat/run-bound.mjs) reaches its report, findings.json and run.json, and a
// --recheck keeps it in all three, as it keeps the budget.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { savedFacts } from '../tools/uat/recheck.mjs';
import { writeReport } from '../tools/uat/report.mjs';
import { runBound } from '../tools/uat/run-bound.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A bound a run stopped at, as its summary says: a turn past --max-turns 2, while step 3’s turns ran. */
function stoppedBound() {
  const b = runBound({ turns: '2' });
  b.beforeStep(3);
  b.see([
    { id: 'a', lastTurnId: 't1', state: 'idle' },
    { id: 'b', lastTurnId: 't2', state: 'idle' },
  ]);
  b.see([{ id: 'a', lastTurnId: 't3', state: 'think' }]);
  return b.summary();
}

test('the report’s usage line and findings.json say the run stopped at its bound', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'uat-bound-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bound = stoppedBound();
  const facts = { streams: [], kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [], bound };
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({ dir, scenario: { title: 'Bound' }, issues: [], findings: [], timeline: [], started: 0, tester: { spent: 0 }, facts, logLines: [] });
  quiet.mock.restore();
  assert.match(
    readFileSync(join(dir, 'report.md'), 'utf8'),
    /\*\*It stopped at its bound\*\* while step 3’s turns ran: its agents started 2 turns, the most --max-turns 2 allows\./,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')).bound, bound);
});

test('a recheck keeps where the run stopped at its bound, from findings.json and run.json', () => {
  const bound = stoppedBound();
  const facts = savedFacts(tempDir('uat-bound-recheck-'), {
    state: { threads: {} },
    mainId: 't1',
    saved: { bound },
    logs: [],
    hostsRec: null,
    record: null,
  });
  assert.deepEqual(facts.bound, bound);
});
