// Where a UAT run’s time goes (tools/uat/timing.mjs): the agents’ turns, the tester’s calls, the scripted waits and the
// verifier, per step and in all, in run.json and report.md’s header. The step times below are the delivery run of
// 30 October’s first steps (uat-runs/2026-10-30T05-16-46-delivery, run.log): @critic’s stopped turn, the tester’s
// next step, a wait of 20 s, and the verifier’s two calls, 75 s and 44 s one after the other.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeReport } from '../tools/uat/report.mjs';
import { readRun, runRecord } from '../tools/uat/runs.mjs';
import { runTiming, timingLine } from '../tools/uat/timing.mjs';

/** A clock that each timed call moves on by the milliseconds it’s given. */
function fakeClock() {
  let t = 0;
  return { now: () => t, spend: (ms) => async () => void (t += ms) };
}

/** The delivery run’s first two steps and its verifier, on the fake clock. */
async function deliveryTiming() {
  const c = fakeClock();
  const timing = runTiming(c.now);
  await timing.time('agents', c.spend(3000)); // before step 1: the room was already calm
  timing.at(1);
  await timing.time('tester', c.spend(4000));
  await timing.time('agents', c.spend(9000)); // @critic’s turn, stopped a second in, until step 2
  timing.at(2);
  await timing.time('tester', c.spend(5000));
  await timing.time('waits', c.spend(20_000));
  await timing.time('agents', c.spend(4000));
  await timing.time('verifier', c.spend(119_000));
  return timing;
}

test('a run’s timing counts the agents’ wait against the step whose action started their turns', async () => {
  const s = (await deliveryTiming()).summary(200_000);
  assert.deepEqual(s.steps, [
    { step: 0, agentMs: 3000, testerMs: 0, waitMs: 0 },
    { step: 1, agentMs: 9000, testerMs: 4000, waitMs: 0 },
    { step: 2, agentMs: 4000, testerMs: 5000, waitMs: 20_000 },
  ]);
  assert.equal(s.verifierMs, 119_000);
});

test('a run’s timing says each kind’s share of the whole run, and what nothing timed took', async () => {
  const s = (await deliveryTiming()).summary(200_000);
  assert.deepEqual(s.share, { agents: 8, tester: 5, waits: 10, verifier: 60, other: 18 });
  assert.equal(timingLine(s), ' Time: agents 8%, tester 5%, waits 10%, verifier 60%, other 18% of 3.3 min; the verifier took 2.0 min.');
});

test('a time that throws is still counted', async () => {
  const c = fakeClock();
  const timing = runTiming(c.now);
  const failing = async () => {
    await c.spend(7000)();
    throw new Error('The tester didn’t answer.');
  };
  await assert.rejects(timing.time('tester', failing), /The tester didn’t answer/);
  assert.equal(timing.summary(7000).testerMs, 7000);
});

test('a run recorded before timing has no time line', () => {
  assert.equal(timingLine(undefined), '');
  assert.equal(timingLine(null), '');
});

test('run.json and report.md’s header carry the run’s timing', async (t) => {
  const timing = (await deliveryTiming()).summary(200_000);
  const facts = { streams: [], kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [], timing };
  const rec = runRecord({
    root: '/repo',
    dir: '/runs/2026-10-30T05-16-46-delivery',
    scenario: { title: 'Delivery', phases: [] },
    name: 'delivery',
    opt: {},
    started: 0,
    steps: 2,
    cap: 12,
    tester: { spent: 0 },
    facts,
    coverage: [],
    now: 200_000,
    git: () => null,
  });
  assert.deepEqual(rec.timing, timing);
  const dir = mkdtempSync(join(tmpdir(), 'uat-timing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({ dir, scenario: { title: 'Delivery' }, issues: [], findings: [], timeline: [], started: 0, tester: { spent: 0 }, facts, logLines: [] });
  quiet.mock.restore();
  const header = readFileSync(join(dir, 'report.md'), 'utf8').split('\n')[2];
  assert.match(header, /Time: agents 8%, tester 5%, waits 10%, verifier 60%, other 18% of 3\.3 min; the verifier took 2\.0 min\./);
});

test('a recheck keeps the timing the live run measured', async (t) => {
  // A recheck rewrites run.json from readRun’s record: without timing in it, a rechecked copy of the thread-focus run of
  // 29 October lost the timing put in its run.json.
  const timing = (await deliveryTiming()).summary(200_000);
  const dir = mkdtempSync(join(tmpdir(), 'uat-timing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [], timeline: [] }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ scenario: 'delivery', timing }));
  assert.deepEqual(readRun(dir)?.timing, timing);
});
