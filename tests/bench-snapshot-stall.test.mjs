// Tests for tools/bench-snapshot-stall.mjs (#508, designs/508/storage-design.md).
// Verifies snapshot stall measurements, event-loop delay reporting, the stall trigger, and that the bench writes
// through the server’s own writeSnapshot.

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
  DEFAULT_STALL_BUDGET_MS,
  measureSnapshotPass,
  parseNum,
  resolveSnapshotState,
  runBenchmark,
  stallOf,
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

test('resolveSnapshotState refuses a --snapshot that isn’t there, rather than measuring synthetic data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    const missing = join(dir, 'snapshot.json');
    assert.throws(() => resolveSnapshotState({ snapshot: missing }), /No snapshot at .*snapshot\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSnapshotState refuses a --data folder with no snapshot.json in it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-data-'));
  try {
    assert.throws(() => resolveSnapshotState({ data: dir }), /No snapshot at .*snapshot\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSnapshotState refuses a snapshot it can’t parse, and says which file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-test-'));
  try {
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, '{ not json');
    assert.throws(() => resolveSnapshotState({ snapshot: file }), /Could not parse the snapshot at .*snapshot\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI fails on a missing --snapshot and measures nothing', async () => {
  const lines = [];
  const missing = join(tmpdir(), 'pb-bench-no-such-folder', 'snapshot.json');
  await assert.rejects(benchCli(['--json', '--snapshot', missing], { out: (s) => lines.push(s) }), /No snapshot at/);
  assert.deepEqual(lines, [], 'no report from synthetic data');
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

test('runBenchmark triggers S2 on the stall budget alone, with no size budget (#508’s storage design, Q1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-bench-run-'));
  try {
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, JSON.stringify(createSyntheticState(20)));

    const withinBudget = await runBenchmark({ snapshot: file, iterations: 2, stallBudgetMs: 50 });
    assert.equal(withinBudget.stallBudgetMs, 50);
    assert.equal(withinBudget.isStallExceeded, false);
    assert.equal(withinBudget.triggerS2, false);
    assert.ok(withinBudget.sizeMB > 0, 'the size is still reported');
    assert.equal('sizeBudgetMB' in withinBudget, false);
    assert.equal('isSizeExceeded' in withinBudget, false);

    // A zero stall budget triggers without reverting to 50
    const zeroBudget = await runBenchmark({ snapshot: file, iterations: 1, stallBudgetMs: 0 });
    assert.equal(zeroBudget.stallBudgetMs, 0);
    assert.equal(zeroBudget.isStallExceeded, true);
    assert.equal(zeroBudget.triggerS2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stallOf is the longest of the stringify, the loop’s worst delay and the timer’s lag', () => {
  assert.equal(stallOf({ stringifyMs: 3, maxDelay: 7, timerDelay: 5 }), 7);
  assert.equal(stallOf({ stringifyMs: 9, maxDelay: 7, timerDelay: 5 }), 9);
  assert.equal(stallOf({ stringifyMs: 3, maxDelay: 2, timerDelay: 5 }), 5);
});

/** A stand-in for node:fs/promises that records what writeSnapshot asks of it. */
function recordingIo() {
  const seen = { opened: '', writes: /** @type {number[]} */ ([]), renamed: /** @type {string[]} */ ([]), removed: /** @type {string[]} */ ([]) };
  const fh = {
    write: async (/** @type {Buffer} */ _buf, /** @type {number} */ _off, /** @type {number} */ len) => {
      seen.writes.push(len);
      return { bytesWritten: len };
    },
    sync: async () => {},
    close: async () => {},
  };
  const io = {
    open: async (/** @type {string} */ path) => {
      seen.opened = path;
      return fh;
    },
    rename: async (/** @type {string} */ from, /** @type {string} */ to) => {
      seen.renamed = [from, to];
    },
    rm: async (/** @type {string} */ path) => {
      seen.removed.push(path);
    },
  };
  return { io, seen };
}

test('measureSnapshotPass writes through the server’s writeSnapshot: 1 MB pieces to a temp file, renamed over snapshot.json', async () => {
  const { io, seen } = recordingIo();
  const state = { version: 1, seq: 1, items: { th_bench: [{ id: 'it_1', text: 'x'.repeat(3.5 * 2 ** 20) }] } };
  const pass = await measureSnapshotPass(state, '/nowhere', { io: /** @type {any} */ (io) });
  const bytes = Buffer.byteLength(JSON.stringify(state));
  assert.equal(pass.bytes, bytes);
  assert.equal(seen.writes.length, 4, 'a 3.5 MB snapshot goes in four pieces');
  for (const n of seen.writes) assert.ok(n <= 2 ** 20, `a piece of ${n} bytes is over 1 MB`);
  assert.equal(
    seen.writes.reduce((a, b) => a + b, 0),
    bytes,
  );
  assert.notEqual(seen.opened, join('/nowhere', 'snapshot.json'), 'written to a temporary file first');
  assert.deepEqual(seen.renamed, [seen.opened, join('/nowhere', 'snapshot.json')]);
  assert.deepEqual(seen.removed, [join('/nowhere', 'snapshot.json')], 'the bench removes the snapshot it wrote');
});

test('runBenchmark measures a seeded big-room store with --items', async () => {
  const lines = [];
  const code = await benchCli(['--json', '--items', '40', '--iterations', '1'], { out: (s) => lines.push(s) });
  assert.equal(code, 0);
  const parsed = JSON.parse(lines.join('\n'));
  assert.equal(parsed.source, 'a seeded big room of 40 items');
  assert.equal(parsed.items, 40);
});

test('CLI refuses the dropped size budget and a malformed --items', async () => {
  await assert.rejects(benchCli(['--budget-size', '40'], { out: () => {} }), /budget-size/);
  await assert.rejects(benchCli(['--items', '1e3'], { out: () => {} }), /--items takes a whole number/);
});

test('the CLI refuses --items with --snapshot or --data, and measures nothing', async () => {
  const lines = [];
  const out = (/** @type {string} */ s) => lines.push(s);
  const refused = /--items seeds a room of its own: give it without --snapshot or --data/;
  await assert.rejects(benchCli(['--json', '--items', '40', '--snapshot', 'snapshot.json'], { out }), refused);
  await assert.rejects(benchCli(['--json', '--items', '40', '--data', 'data'], { out }), refused);
  await assert.rejects(benchCli(['--json', '--items', '40', 'snapshot.json'], { out }), refused);
  assert.deepEqual(lines, [], 'no report from the seeded room in the snapshot’s place');
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
  assert.ok(typeof parsed.triggerS2 === 'boolean');
});
