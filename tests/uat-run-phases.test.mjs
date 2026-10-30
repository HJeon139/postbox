// The runner’s --phases (tools/uat/run-scenario.mjs): a run of some of a scenario’s phases plays only those, and
// checks only their triggers for existence, so delivery.md’s phases 1 and 2 run while its later phases name triggers
// that come with #508’s later steps. --phase (the phase to start at) works as before, and the two don’t combine.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordedPhases, selectPhases } from '../tools/uat/phases.mjs';
import { runScenario } from '../tools/uat/run-scenario.mjs';
import { runRecord } from '../tools/uat/runs.mjs';
import { stepCap } from '../tools/uat/scenario.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (opt) => runScenario({ scenario: 'delivery', ...opt }, ROOT);

test('delivery with --phases 1,2 passes the trigger check, and plays only those two phases', () => {
  const { scenario, phases } = run({ phases: '1,2' });
  assert.deepEqual(phases, [1, 2]);
  assert.deepEqual(
    scenario.phases.map((p) => p.title),
    ['Phase 1: Two wakes held at once (A1)', 'Phase 2: A mention past the catch-up cap (A2)'],
  );
  // Its step cap is those phases’ caps added up, not the whole scenario’s 50.
  assert.equal(stepCap(scenario, undefined), 12);
  assert.equal(stepCap(scenario, '20'), 20);
});

test('delivery without --phases is still refused, with the message it had', () => {
  assert.throws(() => run({}), {
    message:
      'This scenario names triggers that don’t exist: urgent-note-delivered, person-queue-three, wake-scheduled, wake-canceled, wake-scheduled, wake-after-drop, compaction. See tools/uat/triggers.mjs.',
  });
  // A chosen phase whose triggers don’t exist yet is refused all the same.
  assert.throws(() => run({ phases: '1,4' }), /names triggers that don’t exist: urgent-note-delivered\. /);
});

test('--phases refuses a phase the scenario hasn’t, or anything but phase numbers', () => {
  for (const bad of ['9', '0', '1,9', 'two', '1,,2', '1-2', '', '1.5'])
    assert.throws(
      () => run({ phases: bad }),
      (e) => /--phases takes phase numbers from 1 to 8/.test(e.message) && e.message.includes(`“${bad}”`),
      bad,
    );
});

test('--phases and --phase don’t combine; --phase alone starts where it did', () => {
  assert.throws(() => run({ phases: '1,2', phase: '2' }), /--phases and --phase don’t combine/);
  assert.throws(() => run({ phases: '1,2', phase: '1' }), /--phases and --phase don’t combine/);
  // --phase alone checks every phase, as before.
  assert.throws(() => run({ phase: '2' }), /names triggers that don’t exist/);
});

test('--phases in any order or repeated plays them once each, in the scenario’s order, and the run records which', () => {
  const s = { title: 'T', steps: 50, summary: 'S', phases: [1, 2, 3].map((n) => ({ title: `Phase ${n}`, triggers: ['t'], steps: n })) };
  const out = selectPhases(s, [1, 3]);
  assert.deepEqual(
    out.phases.map((p) => p.title),
    ['Phase 1', 'Phase 3'],
  );
  assert.equal(out.steps, null);
  assert.match(out.summary, /only phases 1 and 3 of this scenario[\s\S]*Phase 2/);
  assert.equal(selectPhases(s, null), s);
  const { phases } = runScenario({ scenario: 'delivery', phases: '2,1,2' }, ROOT);
  assert.deepEqual(phases, [1, 2]);
  const record = runRecord({
    root: ROOT,
    dir: '/tmp/x-delivery',
    scenario: out,
    name: 'delivery',
    opt: {},
    started: 0,
    steps: 3,
    cap: 12,
    phases,
    tester: { spent: 0 },
    facts: {},
    coverage: [],
    now: 0,
    git: () => null,
  });
  assert.deepEqual(record.phases, [1, 2]);
  // A recheck plays the phases the record names, and every phase for a record without them.
  assert.deepEqual(recordedPhases(record), [1, 2]);
  assert.equal(recordedPhases({ startPhase: 1 }), null);
});
