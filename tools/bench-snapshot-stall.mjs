#!/usr/bin/env node
// Benchmark event-loop stall during snapshot serialization and writes (#508, designs/508/storage-design.md).
// Measures JSON.stringify time, the server’s own writeSnapshot() (server/store-snapshot.mjs: 1 MB pieces to a temporary
// file, fsynced, renamed), and event-loop delay (p50, p95, max) using monitorEventLoopDelay. Serves as the decision
// trigger for S2 (sharded snapshot).
//
// Budget: a snapshot stall of at most 50 ms, the only trigger (“Decisions and open questions”, Q1: the 40 MB size
// trigger is dropped; the size is still reported).
//
// Usage:
//   node tools/bench-snapshot-stall.mjs [--snapshot <path>] [--data <dir>] [--items <n>] [--iterations <n>]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeSnapshot } from '../server/store-snapshot.mjs';
import { count, loadState, seedRoomFolder, THREAD } from './bench-room.mjs';

export const DEFAULT_STALL_BUDGET_MS = 50;

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
 * Resolves the snapshot to benchmark, returning its raw object and description: the --snapshot file, else the --data
 * folder’s snapshot.json, else synthetic state when neither is given. A snapshot named but missing, or one that can’t
 * be parsed, is refused: measuring synthetic data in its place read as a result for the snapshot.
 * @param {{ snapshot?: string, data?: string }} opts
 */
export function resolveSnapshotState(opts = {}) {
  const dataDir = opts.data ? resolve(opts.data) : null;
  let snapPath = opts.snapshot ? resolve(opts.snapshot) : null;
  if (!snapPath && dataDir) snapPath = join(dataDir, 'snapshot.json');
  if (snapPath) return readSnapshotState(snapPath, dataDir);

  const synthetic = createSyntheticState(5000);
  const syntheticBytes = Buffer.byteLength(JSON.stringify(synthetic));
  return {
    state: synthetic,
    source: 'synthetic (5,000 items)',
    bytes: syntheticBytes,
    storeBytes: syntheticBytes,
  };
}

/**
 * The snapshot at snapPath, parsed, or an error that says what to give instead.
 * @param {string} snapPath  @param {string|null} dataDir
 */
function readSnapshotState(snapPath, dataDir) {
  if (!existsSync(snapPath)) {
    const whatToGive = 'Give --snapshot a snapshot.json, or --data a Postbox data folder that holds one.';
    throw new Error(`No snapshot at ${snapPath}. ${whatToGive}`);
  }
  const text = readFileSync(snapPath, 'utf8');
  let state;
  try {
    state = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse the snapshot at ${snapPath}: ${e.message}. Give it a snapshot.json a Postbox wrote.`);
  }
  const snapBytes = Buffer.byteLength(text);
  return { state, source: snapPath, bytes: snapBytes, storeBytes: computeStoreBytes(dataDir, snapBytes) };
}

/**
 * Refuses a seeded room that holds fewer items than were asked for: an older seedBigRoomData ignores its count, and a
 * smaller room would read as a smaller stall (critic’s pass on #783). @param {any} state  @param {number} items
 */
export function checkSeeded(state, items) {
  const seeded = state.items?.[THREAD]?.length ?? 0;
  if (seeded < items) throw new Error(`The room seeded ${seeded} of the ${items} items asked for.`);
}

/**
 * The big room at `items`, seeded into a temporary data folder and loaded by the server’s Store, as the state to
 * snapshot; the folder, made under tmp, is removed after. seed is seedRoomFolder(), or a test’s stand-in.
 * @param {number} items  @param {string} [tmp]  @param {typeof seedRoomFolder} [seed]
 */
export async function seededState(items, tmp = tmpdir(), seed = seedRoomFolder) {
  const data = await fs.mkdtemp(join(tmp, `pb-bench-items-${items}-`));
  try {
    await seed(data, items);
    const state = await loadState(data);
    checkSeeded(state, items);
    const bytes = Buffer.byteLength(JSON.stringify(state));
    return { state, source: `a seeded big room of ${items} items`, bytes, storeBytes: computeStoreBytes(data, bytes) };
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
}

/**
 * Measures event loop stall and I/O duration for a single snapshot write pass, through the server’s own
 * writeSnapshot() into scratchDir. io stands in for node:fs/promises, as the Store’s does (tests).
 * @param {any} state
 * @param {string} scratchDir
 * @param {{ syncWork?: (() => void) | null, io?: typeof fs }} [opts]
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

  // 2. The server’s own snapshot write, which stringifies again, then writes in 1 MB pieces
  const io = opts.io ?? fs;
  const at = (/** @type {string} */ name) => join(scratchDir, name);
  const tWrite0 = performance.now();
  await writeSnapshot({ io, at, state });
  const writeMs = performance.now() - tWrite0;
  await io.rm(at('snapshot.json'), { force: true });

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

/** The stall a pass measured: the longest of the stringify, the loop’s worst delay and the timer’s lag. @param {{ stringifyMs: number, maxDelay: number, timerDelay: number }} pass */
export function stallOf(pass) {
  return Math.max(pass.stringifyMs, pass.maxDelay, pass.timerDelay);
}

/** Every pass after one warm-up. @param {any} state  @param {number} iterations */
export async function executePasses(state, iterations) {
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
 *   items?: number,
 *   iterations?: number,
 *   stallBudgetMs?: number,
 * }} [opts]  items: a seeded big room of that many items, in place of a snapshot, and refused with one
 */
export async function runBenchmark(opts = {}) {
  const iterations = Math.max(1, opts.iterations ?? 3);
  const stallBudgetMs = opts.stallBudgetMs ?? DEFAULT_STALL_BUDGET_MS;
  // Each names what to measure: --items used to win silently, so the report named a room that wasn’t asked for.
  if (opts.items && (opts.snapshot || opts.data)) {
    throw new Error('--items seeds a room of its own: give it without --snapshot or --data.');
  }

  const { state, source, storeBytes } = opts.items ? await seededState(opts.items) : resolveSnapshotState(opts);
  const passes = await executePasses(state, iterations);

  // Use median of iterations
  passes.sort((a, b) => a.stringifyMs - b.stringifyMs);
  const median = passes[Math.floor(passes.length / 2)];

  const sizeMB = (storeBytes ?? median.bytes) / (1024 * 1024);

  // The stall is the measured CPU blocking time / event loop delay
  const stallMs = stallOf(median);
  const isStallExceeded = stallMs >= stallBudgetMs;
  const triggerS2 = isStallExceeded;

  return {
    source,
    items: opts.items ?? null,
    sizeMB,
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
  out(`Store Size: ${result.sizeMB.toFixed(2)} MB`);
  out(`JSON.stringify CPU time: ${result.stringifyMs.toFixed(2)} ms`);
  out(`writeSnapshot() time:     ${result.writeMs.toFixed(2)} ms (it stringifies again, then writes in 1 MB pieces)`);
  out(`Stringify and write:      ${result.totalWriteMs.toFixed(2)} ms`);
  out(
    `Event loop delay:         p50 = ${result.loopDelay.p50.toFixed(2)} ms, p95 = ${result.loopDelay.p95.toFixed(2)} ms, max = ${result.loopDelay.max.toFixed(2)} ms (timer lag = ${result.timerDelayMs.toFixed(2)} ms)`,
  );
  out(
    `Measured stall:           ${result.stallMs.toFixed(2)} ms / ${result.stallBudgetMs} ms budget (${result.isStallExceeded ? 'EXCEEDED' : 'within budget'})`,
  );
  out('---');
  out(`S2 Trigger: ${result.triggerS2 ? 'YES (budget exceeded; sharded snapshot is required)' : 'NO (within the 50 ms stall budget; S2 stays on hold)'}`);
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
      items: { type: 'string' },
      iterations: { type: 'string', short: 'n', default: '3' },
      'budget-stall': { type: 'string', default: '50' },
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
  -s, --snapshot <file>    Path to snapshot.json (synthetic state when neither it nor --data is given)
  -d, --data <dir>         Path to Postbox data folder (measures snapshot.json and events-*.jsonl segments)
      --items <n>          A big room of n generated items, seeded into a temporary store (tools/uat/big-room.mjs);
                           not with --snapshot or --data
  -n, --iterations <n>     Number of benchmark iterations (default: 3)
      --budget-stall <ms>  Event loop stall budget in milliseconds (default: 50)
      --json               Output machine-readable JSON
  -h, --help               Show this help message
`);
    return 0;
  }

  const result = await runBenchmark({
    snapshot: values.snapshot ?? positionals[0],
    data: values.data,
    items: values.items === undefined ? undefined : count('items', values.items),
    iterations: parseNum(values.iterations, 3),
    stallBudgetMs: parseNum(values['budget-stall'], DEFAULT_STALL_BUDGET_MS),
  });

  if (values.json) out(JSON.stringify(result, null, 2));
  else printReport(result, out);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  benchCli().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
