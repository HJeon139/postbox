// Tests for tools/bench-snapshot-stall.mjs (#508, designs/508/storage-design.md).
// Verifies snapshot stall measurements, event-loop delay reporting, and budget trigger checks.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import {
  benchCli,
  computeStoreBytes,
  createSyntheticState,
  DEFAULT_SIZE_BUDGET_MB,
  DEFAULT_STALL_BUDGET_MS,
  measureSnapshotPass,
  parseNum,
  resolveSnapshotState,
  runBenchmark,
} from '../tools/bench-snapshot-stall.mjs';

test('createSyntheticState builds a populated Postbox state', () => {
  const state = createSyntheticState(50);
  assert.equal(state.version, 1);
  assert.equal(state.seq, 50);
  assert.equal(state.items.th_bench.length, 50);
  assert.ok(state.items.th_bench[0].text.length > 50);
});

test('resolveSnapshotState uses synthetic state by default when no path is given', () => {
  const resolved = resolveSnapshotState();
  assert.match(resolved.source, /synthetic/);
  assert.ok(resolved.state.items.th_bench.length > 0);
  assert.ok(resolved.bytes > 0);
  assert.equal(resolved.storeBytes, resolved.bytes);
});

test('resolveSnapshotState reads a provided snapshot path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, JSON.stringify({ version: 1, seq: 10, items: {} }));
    const resolved = resolveSnapshotState({ snapshot: file });
    assert.equal(resolved.source, file);
    assert.equal(resolved.state.seq, 10);
    assert.ok(resolved.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeStoreBytes and resolveSnapshotState add up snapshot.json and events segments when data is provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-data-'));
  try {
    const snapFile = join(dir, 'snapshot.json');
    const snapContent = JSON.stringify({ version: 1, seq: 1, items: {} });
    writeFileSync(snapFile, snapContent);

    const event1 = join(dir, 'events-1.jsonl');
    writeFileSync(event1, '{"type":"item","data":{"id":"it_1"}}\n');

    const event2 = join(dir, 'events-2.jsonl');
    writeFileSync(event2, '{"type":"item","data":{"id":"it_2"}}\n');

    const total = computeStoreBytes(dir, 0);
    assert.ok(total > Buffer.byteLength(snapContent));

    const resolved = resolveSnapshotState({ data: dir });
    assert.equal(resolved.source, snapFile);
    assert.equal(resolved.storeBytes, total);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('measureSnapshotPass records stall and detects intentional event loop blocking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-pass-'));
  try {
    const state = createSyntheticState(100);

    // Pass with an intentional 30 ms busy loop
    const result = await measureSnapshotPass(state, dir, {
      syncWork: () => {
        const start = performance.now();
        while (performance.now() - start < 30) {}
      },
    });

    assert.ok(result.bytes > 0);
    assert.ok(result.stringifyMs >= 25, `stringifyMs ${result.stringifyMs} should be >= 25 ms`);
    assert.ok(result.maxDelay >= 25, `maxDelay ${result.maxDelay} should be >= 25 ms`);
    assert.ok(result.timerDelay >= 25, `timerDelay ${result.timerDelay} should be >= 25 ms`);
    assert.ok(result.writeMs >= 0);
    assert.ok(result.totalWriteMs >= result.stringifyMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseNum preserves 0 and finite numbers', () => {
  assert.equal(parseNum('0', 50), 0);
  assert.equal(parseNum(0, 50), 0);
  assert.equal(parseNum('100', 50), 100);
  assert.equal(parseNum(undefined, 50), 50);
  assert.equal(parseNum('', 50), 50);
  assert.equal(parseNum('invalid', 50), 50);
});

test('runBenchmark calculates budgets and evaluates PR 2 trigger status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-run-'));
  try {
    const file = join(dir, 'snapshot.json');
    const smallState = createSyntheticState(20);
    writeFileSync(file, JSON.stringify(smallState));

    // Case 1: Small snapshot well within default budgets (50 ms, 40 MB)
    const withinBudget = await runBenchmark({
      snapshot: file,
      iterations: 2,
      stallBudgetMs: 50,
      sizeBudgetMB: 40,
    });
    assert.equal(withinBudget.sizeBudgetMB, 40);
    assert.equal(withinBudget.stallBudgetMs, 50);
    assert.equal(withinBudget.isSizeExceeded, false);
    assert.equal(withinBudget.isStallExceeded, false);
    assert.equal(withinBudget.triggerS2, false);

    // Case 2: Zero / low stall budget forces trigger without reverting to 50
    const zeroBudget = await runBenchmark({
      snapshot: file,
      iterations: 1,
      stallBudgetMs: 0,
      sizeBudgetMB: 40,
    });
    assert.equal(zeroBudget.stallBudgetMs, 0);
    assert.equal(zeroBudget.isStallExceeded, true);
    assert.equal(zeroBudget.triggerS2, true);

    // Case 3: Exceeded size budget
    const exceededSize = await runBenchmark({
      snapshot: file,
      iterations: 1,
      stallBudgetMs: 50,
      sizeBudgetMB: 0.0001,
    });
    assert.equal(exceededSize.isSizeExceeded, true);
    assert.equal(exceededSize.triggerS2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI runs default synthetic path and outputs JSON when requested', async () => {
  const lines = [];
  const code = await benchCli(['--json', '--iterations', '1'], { out: (s) => lines.push(s) });
  assert.equal(code, 0);
  const parsed = JSON.parse(lines.join('\n'));
  assert.match(parsed.source, /synthetic/);
  assert.ok(typeof parsed.stallMs === 'number');
  assert.ok(typeof parsed.sizeMB === 'number');
  assert.equal(parsed.stallBudgetMs, DEFAULT_STALL_BUDGET_MS);
  assert.equal(parsed.sizeBudgetMB, DEFAULT_SIZE_BUDGET_MB);
  assert.ok(typeof parsed.triggerS2 === 'boolean');
});
