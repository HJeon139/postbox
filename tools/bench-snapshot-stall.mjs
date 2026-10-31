#!/usr/bin/env node
// Benchmark event-loop stall during snapshot serialization and writes (#508, designs/508/storage-design.md).
// Measures JSON.stringify time, atomic disk write time, and event-loop delay (p50, p95, max)
// using monitorEventLoopDelay. Serves as the decision trigger for S2 (sharded snapshot).
//
// Budget:
//   - Max snapshot stall: 50 ms
//   - Max store size: 40 MB
//
// Usage:
//   node tools/bench-snapshot-stall.mjs [--snapshot <path>] [--data <dir>] [--iterations <n>]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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
 * Computes the total store bytes in a data directory (snapshot.json + events-*.jsonl), matching Store.size().
 * @param {string|null} dataDir
 * @param {number} fallbackBytes
 */
export function computeStoreBytes(dataDir, fallbackBytes) {
  if (!dataDir || !existsSync(dataDir)) return fallbackBytes;
  try {
    let total = 0;
    for (const n of readdirSync(dataDir)) {
      if (n === 'snapshot.json' || /^events-/.test(n)) {
        total += statSync(join(dataDir, n)).size;
      }
    }
    return total;
  } catch {
    return fallbackBytes;
  }
}

/**
 * Resolves the snapshot to benchmark, returning its raw object and description.
 * Defaults to synthetic state if neither snapshot nor data directory is provided.
 * @param {{ snapshot?: string, data?: string }} opts
 */
export function resolveSnapshotState(opts = {}) {
  let snapPath = opts.snapshot ? resolve(opts.snapshot) : null;
  const dataDir = opts.data ? resolve(opts.data) : null;
  if (!snapPath && dataDir) {
    snapPath = join(dataDir, 'snapshot.json');
  }

  if (snapPath && existsSync(snapPath)) {
    try {
      const text = readFileSync(snapPath, 'utf8');
      const state = JSON.parse(text);
      const snapBytes = Buffer.byteLength(text);
      const storeBytes = computeStoreBytes(dataDir, snapBytes);
      return { state, source: snapPath, bytes: snapBytes, storeBytes };
    } catch (e) {
      console.warn(`Could not parse snapshot at ${snapPath}: ${e.message}`);
    }
  }

  const synthetic = createSyntheticState(5000);
  const json = JSON.stringify(synthetic);
  const syntheticBytes = Buffer.byteLength(json);
  const storeBytes = computeStoreBytes(dataDir, syntheticBytes);
  return {
    state: synthetic,
    source: 'synthetic (5,000 items)',
    bytes: syntheticBytes,
    storeBytes,
  };
}

async function writeSnapshotAtomic(scratchDir, json) {
  const tmpPath = join(scratchDir, `bench-snap-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const targetPath = join(scratchDir, `bench-snap-${process.pid}.json`);
  const t0 = performance.now();
  await writeFile(tmpPath, json);
  const fh = await open(tmpPath, 'r+');
  await fh.sync();
  await fh.close();
  await rename(tmpPath, targetPath);
  const writeMs = performance.now() - t0;
  try {
    await unlink(targetPath);
  } catch {}
  return writeMs;
}

/**
 * Measures event loop stall and I/O duration for a single snapshot write pass.
 * @param {any} state
 * @param {string} scratchDir
 * @param {{ syncWork?: (() => void) | null }} [opts]
 */
export async function measureSnapshotPass(state, scratchDir, opts = {}) {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  // Allow the monitor to start sampling intervals before blocking
  await new Promise((r) => setTimeout(r, 10));

  let timerFiredAt = 0;
  const timerStart = performance.now();
  setTimeout(() => {
    timerFiredAt = performance.now();
  }, 0);

  // 1. Synchronous CPU stall (custom sync work or JSON.stringify)
  const tStringify0 = performance.now();
  if (typeof opts.syncWork === 'function') opts.syncWork();
  const json = JSON.stringify(state);
  const stringifyMs = performance.now() - tStringify0;

  // 2. Atomic disk write matching server/store.mjs writeSnapshot()
  const writeMs = await writeSnapshotAtomic(scratchDir, json);

  // Let event loop catch up to record the stall
  await new Promise((r) => setTimeout(r, 50));
  delay.disable();

  return {
    bytes: Buffer.byteLength(json),
    stringifyMs,
    writeMs,
    totalWriteMs: stringifyMs + writeMs,
    p50: delay.percentile(50) / 1e6,
    p95: delay.percentile(95) / 1e6,
    maxDelay: delay.max / 1e6,
    timerDelay: timerFiredAt > 0 ? timerFiredAt - timerStart : 0,
  };
}

async function executePasses(state, iterations) {
  const scratchDir = join(tmpdir(), `pb-bench-snap-${process.pid}-${Date.now()}`);
  mkdirSync(scratchDir, { recursive: true });
  const passes = [];
  try {
    await measureSnapshotPass(state, scratchDir);
    for (let i = 0; i < iterations; i++) {
      passes.push(await measureSnapshotPass(state, scratchDir));
    }
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  }
  return passes;
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

  const { state, source, storeBytes } = resolveSnapshotState(opts);
  const passes = await executePasses(state, iterations);

  // Use median of iterations
  passes.sort((a, b) => a.stringifyMs - b.stringifyMs);
  const median = passes[Math.floor(passes.length / 2)];

  const sizeMB = (storeBytes ?? median.bytes) / (1024 * 1024);
  const isSizeExceeded = sizeMB >= sizeBudgetMB;

  // The stall is the measured CPU blocking time / event loop delay
  const stallMs = Math.max(median.stringifyMs, median.maxDelay, median.timerDelay);
  const isStallExceeded = stallMs >= stallBudgetMs;
  const triggerS2 = isSizeExceeded || isStallExceeded;

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
    timerDelayMs: median.timerDelay,
    stallMs,
    stallBudgetMs,
    isStallExceeded,
    triggerS2,
    triggerPR2: triggerS2,
    passes,
  };
}

function printReport(result, out = console.log) {
  out('=== Snapshot Stall Benchmark (#508, designs/508/storage-design.md) ===');
  out(`Source: ${result.source}`);
  out(`Store Size: ${result.sizeMB.toFixed(2)} MB / ${result.sizeBudgetMB} MB budget (${result.isSizeExceeded ? 'EXCEEDED' : 'within budget'})`);
  out(`JSON.stringify CPU time: ${result.stringifyMs.toFixed(2)} ms`);
  out(`Atomic disk write time:   ${result.writeMs.toFixed(2)} ms`);
  out(`Total writeSnapshot:      ${result.totalWriteMs.toFixed(2)} ms`);
  out(
    `Event loop delay:         p50 = ${result.loopDelay.p50.toFixed(2)} ms, p95 = ${result.loopDelay.p95.toFixed(2)} ms, max = ${result.loopDelay.max.toFixed(2)} ms (timer lag = ${result.timerDelayMs.toFixed(2)} ms)`,
  );
  out(
    `Measured stall:           ${result.stallMs.toFixed(2)} ms / ${result.stallBudgetMs} ms budget (${result.isStallExceeded ? 'EXCEEDED' : 'within budget'})`,
  );
  out('---');
  out(`S2 Trigger: ${result.triggerS2 ? 'YES (budget exceeded; sharded snapshot is required)' : 'NO (within 50 ms stall and 40 MB budget; S2 stays on hold)'}`);
}

/**
 * Parses numeric CLI values while preserving 0 as a valid number.
 * @param {string|undefined|null} val
 * @param {number} fallback
 */
export function parseNum(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * CLI runner for benchmarking snapshot stalls.
 * @param {string[]} [args]
 * @param {{ out?: (msg: string) => void }} [io]
 */
export async function benchCli(args = process.argv.slice(2), { out = console.log } = {}) {
  const { values, positionals } = parseArgs({
    args,
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
    out(`
Usage: node tools/bench-snapshot-stall.mjs [options] [path-to-snapshot.json]

Measures snapshot serialization and write latency against the S2 budget.

Options:
  -s, --snapshot <file>    Path to snapshot.json (defaults to synthetic state if omitted)
  -d, --data <dir>         Path to Postbox data folder (measures snapshot.json and events-*.jsonl segments)
  -n, --iterations <n>     Number of benchmark iterations (default: 3)
      --budget-stall <ms>  Event loop stall budget in milliseconds (default: 50)
      --budget-size <mb>   Store size budget in megabytes (default: 40)
      --json               Output machine-readable JSON
  -h, --help               Show this help message
`);
    return 0;
  }

  const result = await runBenchmark({
    snapshot: values.snapshot ?? positionals[0],
    data: values.data,
    iterations: parseNum(values.iterations, 3),
    stallBudgetMs: parseNum(values['budget-stall'], DEFAULT_STALL_BUDGET_MS),
    sizeBudgetMB: parseNum(values['budget-size'], DEFAULT_SIZE_BUDGET_MB),
  });

  if (values.json) out(JSON.stringify(result, null, 2));
  else printReport(result, out);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  benchCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
