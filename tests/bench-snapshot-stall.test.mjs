// Tests for tools/bench-snapshot-stall.mjs (#508, plan-no-redis-1).
// Verifies snapshot stall measurements, event-loop delay reporting, and budget trigger checks.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSyntheticState, measureSnapshotPass, resolveSnapshotState, runBenchmark } from '../tools/bench-snapshot-stall.mjs';

test('createSyntheticState builds a populated Postbox state', () => {
  const state = createSyntheticState(50);
  assert.equal(state.version, 1);
  assert.equal(state.seq, 50);
  assert.equal(state.items.th_bench.length, 50);
  assert.ok(state.items.th_bench[0].text.length > 50);
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

test('resolveSnapshotState falls back to synthetic state when file does not exist', () => {
  const resolved = resolveSnapshotState({ snapshot: '/nonexistent/path/snapshot.json' });
  assert.match(resolved.source, /synthetic/);
  assert.ok(resolved.state.items.th_bench.length > 0);
});

test('measureSnapshotPass records stringify duration, write duration, and event-loop delay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-pass-'));
  try {
    const state = createSyntheticState(200);
    const result = await measureSnapshotPass(state, dir);
    assert.ok(result.bytes > 0);
    assert.ok(result.stringifyMs >= 0);
    assert.ok(result.writeMs >= 0);
    assert.ok(result.totalWriteMs >= result.stringifyMs);
    assert.ok(result.p50 >= 0);
    assert.ok(result.p95 >= 0);
    assert.ok(result.maxDelay >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.equal(withinBudget.triggerPR2, false);

    // Case 2: Exceeded stall budget
    const exceededStall = await runBenchmark({
      snapshot: file,
      iterations: 1,
      stallBudgetMs: 0.0001, // Artificially low budget to force trigger
      sizeBudgetMB: 40,
    });
    assert.equal(exceededStall.isStallExceeded, true);
    assert.equal(exceededStall.triggerPR2, true);

    // Case 3: Exceeded size budget
    const exceededSize = await runBenchmark({
      snapshot: file,
      iterations: 1,
      stallBudgetMs: 50,
      sizeBudgetMB: 0.0001, // Artificially low size budget
    });
    assert.equal(exceededSize.isSizeExceeded, true);
    assert.equal(exceededSize.triggerPR2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
