// The report of PF-1’s key-to-frame tool (#508, tools/key-frame-report.mjs): a table per room size, each size’s
// ratio to 1× and its verdict against the 10% budget, that Safari wasn’t measured, and where the numbers came from.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { belowLine, budgetRows, formatReport } from '../tools/key-frame-report.mjs';

const sum = (p95) => ({ n: 200, p50: p95 / 2, p95, max: p95 * 2 });
const results = [
  { items: 1000, eventTiming: sum(40), nextFrame: sum(30), below: 3 },
  { items: 4000, eventTiming: sum(42), nextFrame: sum(31), below: 0 },
  { items: 10000, eventTiming: sum(48), nextFrame: sum(36), below: 0 },
];
const report = () =>
  formatReport({
    command: 'node tools/bench-key-frame.mjs --sizes 1000,4000,10000 --out designs/508/key-frame.md',
    commit: 'abc1234',
    date: '2026-11-04T10:00:00.000Z',
    machine: { os: 'Linux 6.12', arch: 'x64', cpu: 'Test CPU', node: 'v24.0.0', chromium: '140.0.1' },
    inputs: { sizes: [1000, 4000, 10000], keys: 200, warmup: 20, runs: 3, intervalMs: 50 },
    results,
  });

test('each size is judged by its Event Timing p95 against the smallest room’s, the 1× room', () => {
  const rows = budgetRows(results, 0.1);
  assert.deepEqual(
    rows.map((r) => [r.items, r.ratio, r.pass]),
    [
      [1000, 1, true],
      [4000, 1.05, true],
      [10000, 1.2, false],
    ],
  );
});

test('the report has a table per size, the ratio and verdict, and fails PF-1 when one size is past budget', () => {
  const md = report();
  assert.match(md, /### 1,000 items \(1×\)/);
  assert.match(md, /### 4,000 items \(4×\)/);
  assert.match(md, /### 10,000 items \(10×\)/);
  assert.match(md, /\| 10,000 \| 10× \| 48\.0 ms \| 1\.20 \| fail \|/);
  assert.match(md, /PF-1: \*\*fail\*\*/);
});

test('the report says Safari wasn’t measured, and that it isn’t a CI gate', () => {
  const md = report();
  assert.match(md, /Safari: not measured/);
  assert.match(md, /not a CI gate/);
});

test('the report records its command, inputs, commit and machine', () => {
  const md = report();
  for (const want of ['node tools/bench-key-frame.mjs --sizes 1000,4000,10000', 'abc1234', 'Linux 6.12', 'x64', 'Test CPU', 'v24.0.0', '140.0.1', '200 keys'])
    assert.ok(md.includes(want), `the report names ${want}`);
});

test('belowLine: with no key under the threshold, the report says every key had an entry', () => {
  assert.equal(belowLine(0, 100, 16), 'Every key had an Event Timing entry.');
  assert.equal(belowLine(3, 100, 16), '3 of 100 keys had no Event Timing entry, so took under 16 ms; each counts at 16 ms.');
});
