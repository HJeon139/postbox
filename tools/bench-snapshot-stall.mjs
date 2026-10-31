#!/usr/bin/env node
// Benchmark event-loop stall during snapshot serialization and writes (#508, plan-no-redis-1).
// Measures JSON.stringify time, atomic disk write time, and event-loop delay (p50, p95, max)
// using monitorEventLoopDelay. Serves as the decision trigger for PR 2 (sharded snapshot).
//
// Budget:
//   - Max snapshot stall: 50 ms
//   - Max store size: 40 MB
//
// Usage:
//   node tools/bench-snapshot-stall.mjs [--snapshot <path>] [--data <dir>] [--iterations <n>]

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

export const DEFAULT_STALL_BUDGET_MS = 50;
export const DEFAULT_SIZE_BUDGET_MB = 40;

/**
 * Creates a synthetic state object if no real snapshot file is available.
 * @param {number} itemsCount
 */
export function createSyntheticState(itemsCount = 1000) {
  const items = [];
  for (let i = 1; i <= itemsCount; i++) {
    items.push({
      id: `it_${i.toString(36)}`,
      kind: i % 2 === 0 ? 'agent' : 'user',
      handle: i % 2 === 0 ? 'researcher' : undefined,
      text: `Benchmark item message ${i} with simulated payload content `.repeat(10),
      at: 1700000000000 + i * 1000,
      turnId: `turn_${Math.floor(i / 2)}`,
    });
  }
  return {
    version: 1,
    seq: itemsCount,
    settings: { model: 'claude-haiku-5-5' },
    projects: { pr_bench: { id: 'pr_bench', name: 'Benchmark', folder: '/tmp/bench' } },
    personas: { researcher: { id: 'pe_researcher', handle: 'researcher', backend: 'claude-code' } },
    threads: { th_bench: { id: 'th_bench', projectId: 'pr_bench', title: 'Benchmark Room' } },
    sessions: {},
    items: { th_bench: items },
  };
}

/**
 * Resolves the snapshot to benchmark, returning its raw object and description.
 * @param {{ snapshot?: string, data?: string }} opts
 */
export function resolveSnapshotState(opts = {}) {
  let snapPath = opts.snapshot ? resolve(opts.snapshot) : null;
  if (!snapPath && opts.data) {
    snapPath = join(resolve(opts.data), 'snapshot.json');
  }
  if (!snapPath) {
    const homeSnap = join(homedir(), '.postbox', 'snapshot.json');
    if (existsSync(homeSnap)) snapPath = homeSnap;
  }
  if (!snapPath) {
    const localDataSnap = join(process.cwd(), 'data', 'snapshot.json');
    if (existsSync(localDataSnap)) snapPath = localDataSnap;
  }

  if (snapPath && existsSync(snapPath)) {
    try {
      const text = readFileSync(snapPath, 'utf8');
      const state = JSON.parse(text);
      return { state, source: snapPath, bytes: Buffer.byteLength(text) };
    } catch (e) {
      console.warn(`Could not parse snapshot at ${snapPath}: ${e.message}`);
    }
  }

  const synthetic = createSyntheticState(5000);
  const json = JSON.stringify(synthetic);
  return { state: synthetic, source: 'synthetic (5,000 items)', bytes: Buffer.byteLength(json) };
}

/**
 * Measures event loop stall and I/O duration for a single snapshot write pass.
 * @param {any} state
 * @param {string} scratchDir
 */
export async function measureSnapshotPass(state, scratchDir) {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  await new Promise((r) => setTimeout(r, 10));

  delay.enable();

  // 1. Synchronous stringification (main thread CPU stall)
  const tStringify0 = performance.now();
  const json = JSON.stringify(state);
  const tStringify1 = performance.now();
  const stringifyMs = tStringify1 - tStringify0;

  // 2. Atomic disk write matching server/store.mjs writeSnapshot()
  const tmpPath = join(scratchDir, `bench-snap-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const targetPath = join(scratchDir, `bench-snap-${process.pid}.json`);

  const tWrite0 = performance.now();
  await writeFile(tmpPath, json);
  const fh = await open(tmpPath, 'r+');
  await fh.sync();
  await fh.close();
  await rename(tmpPath, targetPath);
  const tWrite1 = performance.now();
  const writeMs = tWrite1 - tWrite0;

  // Let event loop catch up to record the stall
  await new Promise((r) => setTimeout(r, 50));
  delay.disable();

  try {
    await unlink(targetPath);
  } catch {}

  const p50 = delay.percentile(50) / 1e6;
  const p95 = delay.percentile(95) / 1e6;
  const maxDelay = delay.max / 1e6;

  return {
    bytes: Buffer.byteLength(json),
    stringifyMs,
    writeMs,
    totalWriteMs: stringifyMs + writeMs,
    p50,
    p95,
    maxDelay,
  };
}

/**
 * Runs the benchmark across iterations and summarizes results against budgets.
 * @param {{
 *   snapshot?: string,
 *   data?: string,
 *   iterations?: number,
 *   stallBudgetMs?: number,
 *   sizeBudgetMB?: number,
 * }} [opts]
 */
export async function runBenchmark(opts = {}) {
  const iterations = Math.max(1, opts.iterations ?? 3);
  const stallBudgetMs = opts.stallBudgetMs ?? DEFAULT_STALL_BUDGET_MS;
  const sizeBudgetMB = opts.sizeBudgetMB ?? DEFAULT_SIZE_BUDGET_MB;

  const { state, source } = resolveSnapshotState(opts);

  const scratchDir = join(tmpdir(), `pb-bench-snap-${process.pid}-${Date.now()}`);
  mkdirSync(scratchDir, { recursive: true });

  const passes = [];
  try {
    // Warm-up pass
    await measureSnapshotPass(state, scratchDir);

    for (let i = 0; i < iterations; i++) {
      const result = await measureSnapshotPass(state, scratchDir);
      passes.push(result);
    }
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  }

  // Use median of iterations
  passes.sort((a, b) => a.stringifyMs - b.stringifyMs);
  const median = passes[Math.floor(passes.length / 2)];

  const sizeMB = median.bytes / (1024 * 1024);
  const isSizeExceeded = sizeMB >= sizeBudgetMB;

  // The stall is the CPU blocking time (or max loop delay)
  const stallMs = Math.max(median.stringifyMs, median.maxDelay);
  const isStallExceeded = stallMs >= stallBudgetMs;
  const triggerPR2 = isSizeExceeded || isStallExceeded;

  return {
    source,
    sizeMB,
    sizeBudgetMB,
    isSizeExceeded,
    stringifyMs: median.stringifyMs,
    writeMs: median.writeMs,
    totalWriteMs: median.totalWriteMs,
    loopDelay: {
      p50: median.p50,
      p95: median.p95,
      max: median.maxDelay,
    },
    stallMs,
    stallBudgetMs,
    isStallExceeded,
    triggerPR2,
    passes,
  };
}

function printReport(result) {
  console.log('=== Snapshot Stall Benchmark (#508, plan-no-redis-1) ===');
  console.log(`Source: ${result.source}`);
  console.log(`Store Size: ${result.sizeMB.toFixed(2)} MB / ${result.sizeBudgetMB} MB budget (${result.isSizeExceeded ? 'EXCEEDED' : 'within budget'})`);
  console.log(`JSON.stringify CPU time: ${result.stringifyMs.toFixed(2)} ms`);
  console.log(`Atomic disk write time:   ${result.writeMs.toFixed(2)} ms`);
  console.log(`Total writeSnapshot:      ${result.totalWriteMs.toFixed(2)} ms`);
  console.log(
    `Event loop delay:         p50 = ${result.loopDelay.p50.toFixed(2)} ms, p95 = ${result.loopDelay.p95.toFixed(2)} ms, max = ${result.loopDelay.max.toFixed(2)} ms`,
  );
  console.log(
    `Measured stall:           ${result.stallMs.toFixed(2)} ms / ${result.stallBudgetMs} ms budget (${result.isStallExceeded ? 'EXCEEDED' : 'within budget'})`,
  );
  console.log('---');
  console.log(
    `PR 2 Trigger: ${
      result.triggerPR2 ? 'YES (budget exceeded; sharded snapshot is required)' : 'NO (within 50 ms stall and 40 MB budget; PR 2 stays on hold)'
    }`,
  );
}

/** CLI entry point */
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      snapshot: { type: 'string', short: 's' },
      data: { type: 'string', short: 'd' },
      iterations: { type: 'string', short: 'n', default: '3' },
      'budget-stall': { type: 'string', default: '50' },
      'budget-size': { type: 'string', default: '40' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Usage: node tools/bench-snapshot-stall.mjs [options] [path-to-snapshot.json]

Measures snapshot serialization and write latency against the PR 2 budget.

Options:
  -s, --snapshot <file>    Path to snapshot.json (defaults to ~/.postbox/snapshot.json if present)
  -d, --data <dir>         Path to Postbox data folder containing snapshot.json
  -n, --iterations <n>     Number of benchmark iterations (default: 3)
      --budget-stall <ms>  Event loop stall budget in milliseconds (default: 50)
      --budget-size <mb>   Store size budget in megabytes (default: 40)
      --json               Output machine-readable JSON
  -h, --help               Show this help message
`);
    process.exit(0);
  }

  const result = await runBenchmark({
    snapshot: values.snapshot ?? positionals[0],
    data: values.data,
    iterations: Number(values.iterations) || 3,
    stallBudgetMs: Number(values['budget-stall']) || 50,
    sizeBudgetMB: Number(values['budget-size']) || 40,
  });

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^[./]+/, ''))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
