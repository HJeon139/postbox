// The budget spec’s verdicts (#1166, tools/budget-stats.mjs): a measure fails past its budget, and one that measured
// nothing, or couldn’t tell, reads as “not measured”, never as a pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUDGET_MS,
  ELEMENT_BUDGET,
  elementsVerdict,
  entriesInOrder,
  gapCalibrated,
  gapVerdict,
  keyTimes,
  timedVerdict,
  unpresented,
} from '../tools/budget-stats.mjs';

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

test('the longest frame gap fails past the budget, and a loop that didn’t run through the measure is not measured', () => {
  assert.equal(gapVerdict([16, 17, 99], 1000).verdict, 'not measured');
  const enough = Array.from({ length: 60 }, () => 16);
  assert.equal(gapVerdict(enough, 1000).verdict, 'pass');
  const slow = gapVerdict([...enough, 140], 1000);
  assert.equal(slow.verdict, 'fail');
  assert.equal(slow.longest, 140);
  assert.equal(gapVerdict([], 0).verdict, 'not measured');
  // Few frames, because one task held the page: still watched throughout, so a failure, not unmeasured.
  assert.equal(gapVerdict([16, 500, 16, 470], 1000).verdict, 'fail');
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
  // The reference Mac’s display refreshes at 120 Hz: idle frames 8.3 ms apart are a working probe, not a broken one.
  assert.equal(
    gapCalibrated(
      Array.from({ length: 60 }, () => 8.3),
      151,
      150,
    ),
    true,
    'a 120 Hz display',
  );
});

test('mounted elements pass at the budget and fail past it; a count that was never read is not measured', () => {
  assert.equal(elementsVerdict(ELEMENT_BUDGET).verdict, 'pass');
  assert.equal(elementsVerdict(ELEMENT_BUDGET + 1).verdict, 'fail');
  assert.equal(elementsVerdict(null).verdict, 'not measured');
});

test('a key whose entry runs over the budget and on to the next key’s start had its frame unpresented', () => {
  // Keys 50 ms apart, the last one the planted key. Chromium’s full headless mode ran each entry on to a later paint.
  const keys = [{ at: 0 }, { at: 50 }, { at: 100 }, { at: 150 }];
  const held = [
    { name: 'keydown', startTime: 0, duration: 700 },
    { name: 'keydown', startTime: 50, duration: 30 },
    { name: 'keydown', startTime: 100, duration: 50 },
    { name: 'keydown', startTime: 150, duration: 64 },
  ];
  // The first runs past the next key, and over the budget.
  assert.equal(unpresented(keys, held), 1);
  // Over the budget and ending exactly at the next key’s start counts too.
  assert.equal(unpresented([{ at: 0 }, { at: 120 }], [{ name: 'keydown', startTime: 0, duration: 120 }]), 1);
  // A 60 ms key typed every 50 ms runs past the next key but came in time: a time, within the budget.
  assert.equal(unpresented([{ at: 0 }, { at: 50 }], [{ name: 'keydown', startTime: 0, duration: 60 }]), 0);
  // A slow scroll at 10,000 items, 80 ms, that ends before the next press 150 ms later: a time, not a held frame.
  const scrolls = [{ at: 0 }, { at: 150 }, { at: 300 }];
  const slow = [
    { name: 'keydown', startTime: 0, duration: 80 },
    { name: 'keydown', startTime: 150, duration: 96 },
    { name: 'keydown', startTime: 300, duration: 64 },
  ];
  assert.equal(unpresented(scrolls, slow), 0);
  // Over the budget but ending before the next press: a slow time, which fails the budget as a time.
  assert.equal(unpresented([{ at: 0 }, { at: 300 }], [{ name: 'keydown', startTime: 0, duration: 150 }]), 0);
});

test('entries are in key order up to the planted key: none that started before it arrives after its own', () => {
  const before = [
    { name: 'keydown', startTime: 10, duration: 24 },
    { name: 'keydown', startTime: 60, duration: 30 },
  ];
  const planted = { name: 'keydown', startTime: 100, duration: 64 };
  assert.equal(entriesInOrder([...before, planted], 100), true);
  assert.equal(entriesInOrder([before[0], planted, before[1]], 100), false, 'a measured key’s entry came after the planted one');
  assert.equal(entriesInOrder(before, 100), false, 'no planted entry');
});
