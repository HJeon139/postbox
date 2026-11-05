// The report of PF-1’s key-to-frame tool (#508, tools/key-frame-report.mjs): a table per room size, each size’s
// ratio to 1× and its verdict against the 10% budget, that Safari wasn’t measured, and where the numbers came from.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { belowLine, budgetRows, formatReport, shownPath } from '../tools/key-frame-report.mjs';

const sum = (p95) => ({ n: 200, p50: p95 / 2, p95, max: p95 * 2 });
const results = [
  { items: 1000, eventTiming: sum(40), nextFrame: sum(30), below: 3 },
  { items: 4000, eventTiming: sum(42), nextFrame: sum(31), below: 0 },
  { items: 10000, eventTiming: sum(48), nextFrame: sum(36), below: 0 },
];
const reportInputs = {
  command: 'node tools/bench-key-frame.mjs --sizes 1000,4000,10000 --out designs/508/key-frame.md',
  commit: 'abc1234',
  date: '2026-11-04T10:00:00.000Z',
  machine: { os: 'Linux 6.12', arch: 'x64', cpu: 'Test CPU', node: 'v24.0.0', chromium: '140.0.1' },
  inputs: { sizes: [1000, 4000, 10000], keys: 200, warmup: 20, runs: 3, intervalMs: 50 },
};
const report = () => formatReport({ ...reportInputs, results });

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

test('under the summary, the report says Event Timing’s 8 ms steps are coarser than the budget near 24 ms', () => {
  const md = report();
  const summary = md.slice(md.indexOf('## Summary'), md.indexOf('## By size'));
  assert.match(
    summary,
    /\| 1\.20 \| fail \|[^\n]*\n\nEvent Timing reports durations in 8 ms steps, so near a 1× p95 of 24 ms the 10% budget is finer than one step, which is why the next-frame timer is shown\.\n/,
  );
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

test('shownPath: a path in the repo shows relative to it, one outside it as its name, even with the home under a prefix', () => {
  const root = '/local/home/user/postbox';
  assert.equal(shownPath(`${root}/designs/508/key-frame.md`, root), 'designs/508/key-frame.md');
  assert.equal(shownPath('/local/home/user/runs/key-frame.md', root), 'key-frame.md');
  assert.equal(shownPath('/local/home/user/postbox-other/key-frame.md', root), 'key-frame.md', 'a sibling folder whose name starts like the repo’s');
});

/** A fast machine’s rooms: the 1× room with `below` of its 100 keys under one frame, and a 4× room at `p95`. */
const fast = (below, p95) => [
  { items: 1000, eventTiming: { ...sum(16), n: 100 }, nextFrame: sum(9), below },
  { items: 4000, eventTiming: { ...sum(p95), n: 100 }, nextFrame: sum(44), below: 0 },
];
const reportOf = (rooms) => formatReport({ ...reportInputs, results: rooms });

test('a fast machine’s 1× room, mostly under one frame, is judged at 16 ms: a 4× room at 48 ms fails, as on an M5 Max', () => {
  assert.deepEqual(
    budgetRows(fast(49, 48)).map((r) => r.verdict),
    ['pass', 'fail'],
  );
  const md = reportOf(fast(49, 48));
  assert.match(md, /PF-1: \*\*fail\*\*/);
  assert.match(md, /\| 1,000 \| 1× \| ≤ 16 ms \| 1\.00 \| pass \|/);
  assert.match(md, /a larger room passes at up to 17\.6 ms/);
});

test('a 4× room one Event Timing step over a 1× room under one frame fails; one under one frame too passes', () => {
  assert.deepEqual(
    budgetRows(fast(49, 24)).map((r) => r.verdict),
    ['pass', 'fail'],
  );
  assert.deepEqual(
    budgetRows(fast(100, 16)).map((r) => r.verdict),
    ['pass', 'pass'],
  );
  assert.match(reportOf(fast(100, 16)), /PF-1: \*\*pass\*\*/);
});

test('a room that measured no key is not measured, and PF-1 with it', () => {
  const rooms = [{ items: 1000, eventTiming: { n: 0, p50: null, p95: null, max: null }, nextFrame: sum(9), below: 0 }, fast(0, 16)[1]];
  assert.deepEqual(
    budgetRows(rooms).map((r) => r.verdict),
    ['not measured', 'not measured'],
  );
  assert.match(reportOf(rooms), /PF-1: \*\*not measured\*\*/);
});

test('belowLine: a size with most of its keys under one frame says each counts at the threshold, and nothing more', () => {
  assert.equal(belowLine(49, 100, 16), '49 of 100 keys had no Event Timing entry, so took under 16 ms; each counts at 16 ms.');
});
