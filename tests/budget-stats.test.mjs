// The budget spec’s verdicts (#1166, tools/budget-stats.mjs): a measure fails past its budget, and one that measured
// nothing, or couldn’t tell, reads as “not measured”, never as a pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET_MS, ELEMENT_BUDGET, elementsVerdict, gapCalibrated, gapVerdict, keyTimes, timedVerdict } from '../tools/budget-stats.mjs';

test('a key with an entry takes its longest entry, one with none takes the threshold if a frame followed it', () => {
  const keys = [
    { at: 0, framed: true },
    { at: 100, framed: true },
    { at: 200, framed: true },
  ];
  const entries = [
    { name: 'keydown', startTime: 0, duration: 40 },
    { name: 'keypress', startTime: 0, duration: 48 },
    { name: 'keydown', startTime: 200, duration: 24 },
  ];
  assert.deepEqual(keyTimes(keys, entries, 16), { values: [48, 16, 24], unmeasured: 0 });
});

test('a key with no entry and no frame after it is unmeasured, and so is the measure', () => {
  const times = keyTimes(
    [
      { at: 0, framed: true },
      { at: 100, framed: false },
    ],
    [],
    16,
  );
  assert.equal(times.unmeasured, 1);
  assert.equal(timedVerdict(times.values, { unmeasured: times.unmeasured }).verdict, 'not measured');
});

test('a timed measure passes at its budget, fails past it, and with no samples is not measured', () => {
  assert.equal(timedVerdict([16, 20, BUDGET_MS]).verdict, 'pass');
  assert.equal(timedVerdict([16, 20, BUDGET_MS + 1]).verdict, 'fail');
  const none = timedVerdict([]);
  assert.equal(none.verdict, 'not measured');
  assert.equal(none.p95, null);
});

test('a timed measure gives its sample count beside its p95, so one slow open of five reads as one sample', () => {
  const v = timedVerdict([30, 40, 50, 60, 900]);
  assert.equal(v.n, 5);
  assert.equal(v.p95, 900);
  assert.equal(v.verdict, 'fail');
});

test('the longest frame gap fails past the budget, and too few frames for the time is not measured', () => {
  assert.equal(gapVerdict([16, 17, 99], 1000).verdict, 'not measured');
  const enough = Array.from({ length: 60 }, () => 16);
  assert.equal(gapVerdict(enough, 1000).verdict, 'pass');
  const slow = gapVerdict([...enough, 140], 1000);
  assert.equal(slow.verdict, 'fail');
  assert.equal(slow.longest, 140);
  assert.equal(gapVerdict([], 0).verdict, 'not measured');
});

test('the frame probe is calibrated only when an idle page runs near 60 frames a second and a busy loop shows', () => {
  const idle = Array.from({ length: 30 }, (_, i) => 16 + (i % 2));
  assert.equal(gapCalibrated(idle, 160, 150), true);
  assert.equal(gapCalibrated(idle, 120, 150), false, 'the planted loop didn’t show');
  assert.equal(
    gapCalibrated(
      idle.map(() => 100),
      160,
      150,
    ),
    false,
    'a throttled page',
  );
  assert.equal(gapCalibrated([], 160, 150), false, 'no frames at all');
});

test('mounted elements pass at the budget and fail past it; a count that was never read is not measured', () => {
  assert.equal(elementsVerdict(ELEMENT_BUDGET).verdict, 'pass');
  assert.equal(elementsVerdict(ELEMENT_BUDGET + 1).verdict, 'fail');
  assert.equal(elementsVerdict(null).verdict, 'not measured');
});
