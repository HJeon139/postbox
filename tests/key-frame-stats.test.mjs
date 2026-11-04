// The statistics of PF-1’s key-to-frame tool (#508, tools/key-frame-stats.mjs): percentiles over each key’s time, the
// Event Timing entries matched to the key that caused them, and the budget: a large room’s p95 within 10% of 1×’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyDurations, outsideWindow, percentile, summarize, withinBudget } from '../tools/key-frame-stats.mjs';

const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

test('the p95 of 1 to 100 is 95, by nearest rank, whatever order the values come in', () => {
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile([...hundred].reverse(), 95), 95);
});

test('the p95 of twenty keys is the 19th slowest, not the slowest', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
  assert.equal(percentile(twenty, 95), 190);
});

test('a rank that falls between two keys rounds up: the p95 of ten keys is the slowest', () => {
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
  assert.equal(percentile(ten, 95), 100);
  assert.equal(percentile(ten, 50), 50);
});

test('the p95 of eleven keys is the slowest: its rank, 10.45, rounds up to 11, not to the nearest 10', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => (i + 1) * 10);
  assert.equal(percentile(eleven, 95), 110);
});

test('a percentile of no values is null, not zero', () => {
  assert.equal(percentile([], 95), null);
});

test('a summary gives the count, p50, p95 and max', () => {
  assert.deepEqual(summarize(hundred), { n: 100, p50: 50, p95: 95, max: 100 });
});

test('a large room’s p95 exactly 10% over 1×’s is within budget, and just past it isn’t', () => {
  assert.deepEqual(withinBudget(40, 44), { ratio: 1.1, pass: true });
  assert.equal(withinBudget(40, 44.5).pass, false);
  assert.equal(withinBudget(40, 30).pass, true);
});

test('the budget is 10%, not more: 10.05% over 1×’s fails and 9.95% passes', () => {
  assert.equal(withinBudget(100, 110.05).pass, false);
  assert.equal(withinBudget(100, 109.95).pass, true);
  assert.equal(withinBudget(8, 8.8).pass, true, 'exactly 10% over, where the sum is exact');
});

test('each key takes the longest Event Timing entry that started between it and the next key', () => {
  const keys = [100, 200, 300];
  const entries = [
    { name: 'keydown', startTime: 100, duration: 24 },
    { name: 'input', startTime: 101, duration: 40 },
    { name: 'keydown', startTime: 300, duration: 32 },
  ];
  assert.deepEqual(keyDurations(keys, entries, 16), { values: [40, 16, 32], below: 1 });
});

test('entries from before the first key, such as the warm-up’s, count for no key', () => {
  const { values } = keyDurations([100], [{ name: 'keydown', startTime: 90, duration: 200 }], 16);
  assert.deepEqual(values, [16]);
});

test('outsideWindow: a composer the window doesn’t show is named, since a key typed there presents no frame', () => {
  const window = { width: 1280, height: 900 };
  assert.equal(outsideWindow({ top: 824, bottom: 854, left: 300, right: 1200 }, window), null);
  assert.match(outsideWindow({ top: 824, bottom: 854, left: 300, right: 1200 }, { width: 800, height: 600 }), /854.*600/);
  assert.match(outsideWindow({ top: 10, bottom: 40, left: 300, right: 1300 }, window), /1300.*1280/);
});
