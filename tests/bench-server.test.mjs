// Tests for tools/bench-server.mjs and tools/bench-server-report.mjs (#508): its options, the pooling of runs into
// percentiles, the streamed reply, the log at the store’s snapshot limit, one size measured on fakes, and the report.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SNAPSHOT_EVERY, Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { seedRoomFolder, THREAD } from '../tools/bench-room.mjs';
import { commandLine, LOG_EVENTS, measureAll, measureSize, options, pooled, streamChunks, writeLog } from '../tools/bench-server.mjs';
import { formatServerReport } from '../tools/bench-server-report.mjs';

test('options default to the 1×, 4× and 10× rooms, 3 runs, 20 requests and 200 chunks', () => {
  const o = options([]);
  assert.deepEqual(o.sizes, [1000, 4000, 10000]);
  assert.equal(o.runs, 3);
  assert.equal(o.requests, 20);
  assert.equal(o.chunks, 200);
});

test('options refuse a size or a run count that isn’t a whole number of at least 1', () => {
  assert.throws(() => options(['--sizes', '1000,abc']), /--sizes takes a whole number of at least 1, not “abc”/);
  assert.throws(() => options(['--sizes', '1e3']), /--sizes takes a whole number/);
  assert.throws(() => options(['--runs', '0']), /--runs takes a whole number/);
});

test('commandLine spells out every option and shows --out without a folder outside the repo', () => {
  const o = options(['--sizes', '10,20', '--runs', '2', '--out', '/somewhere/private/before-server.md']);
  assert.equal(commandLine(o, '/repo'), 'node tools/bench-server.mjs --sizes 10,20 --runs 2 --requests 20 --chunks 200 --out before-server.md');
});

test('pooled takes the percentiles over every run’s values, not one run’s', () => {
  const runs = [{ t: [1, 2, 3] }, { t: [10, 20, 30] }];
  assert.deepEqual(pooled(runs, 't'), { n: 6, p50: 3, p95: 30, max: 30 });
});

test('the log the startup replays is as long as the store lets one grow before it snapshots', () => {
  assert.equal(LOG_EVENTS, SNAPSHOT_EVERY);
});

test('streamChunks times each item.text chunk of a reply added at the end of the thread', () => {
  const state = emptyState();
  for (let i = 0; i < 5; i++) apply(state, 'item.add', { threadId: THREAD, item: { id: `it_${i}`, kind: 'user', text: 'hi' } });
  const times = streamChunks(state, THREAD, 7);
  assert.equal(times.length, 7);
  for (const t of times) assert.ok(t >= 0);
  const last = state.items[THREAD].at(-1);
  assert.equal(state.items[THREAD].length, 6);
  assert.equal(last.text, 'part of the streamed reply '.repeat(7));
});

test('measureAll measures every size, in the order given', async () => {
  const seen = [];
  const results = await measureAll({ sizes: [30, 10, 20] }, async (items) => {
    seen.push(items);
    return { items };
  });
  assert.deepEqual(seen, [30, 10, 20]);
  assert.deepEqual(
    results.map((r) => r.items),
    [30, 10, 20],
  );
});

test('writeLog leaves a snapshot of the room and a log of LOG_EVENTS events after it', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-bench-log-'));
  try {
    await seedRoomFolder(data, 20);
    await writeLog(data, 50);
    const segments = readdirSync(data).filter((n) => /^events-\d+\.jsonl$/.test(n));
    assert.equal(segments.length, 1);
    const lines = readFileSync(join(data, segments[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 50);
    const snap = JSON.parse(readFileSync(join(data, 'snapshot.json'), 'utf8'));
    assert.equal(snap.items[THREAD].length, 20);
    const store = await new Store(data).load();
    assert.equal(store.sinceSnapshot, 50);
    await store.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

/**
 * A stand-in for startPostbox(): its start empties the folder, as the real one’s --fresh does, and its restart runs
 * whileDown; it records whether the folder held the room once it was back up.
 */
function fakePostbox() {
  const seen = { starts: 0, servedRoom: false };
  const start = async (/** @type {{ data: string }} */ o) => {
    seen.starts++;
    rmSync(o.data, { recursive: true, force: true });
    mkdirSync(o.data);
    return {
      origin: 'http://127.0.0.1:1',
      kill: async () => {},
      restart: async (/** @type {{ whileDown?: () => Promise<void> }} */ r = {}) => {
        await r.whileDown?.();
        seen.servedRoom = existsSync(join(o.data, 'snapshot.json')) || readdirSync(o.data).some((n) => n.startsWith('events-'));
        return 0;
      },
    };
  };
  return { start, seen };
}

/** A body for /api/state whose room holds n items. @param {number} n */
const stateBody = (n) => Buffer.from(JSON.stringify({ state: { items: { [THREAD]: Array.from({ length: n }, (_, i) => ({ id: `it_${i}` })) } } }));

test('measureSize measures the four numbers on a seeded room, a run at a time, and removes its folder', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start, seen } = fakePostbox();
  const body = stateBody(30);
  const get = async () => ({ arrayBuffer: async () => body });
  try {
    const r = await measureSize(30, { runs: 2, requests: 3, chunks: 4, logEvents: 10 }, { start, port: async () => 1, tmp, get });
    assert.equal(r.items, 30);
    assert.equal(r.stall.n, 2);
    assert.equal(r.stringify.n, 2);
    assert.equal(r.api.n, 6);
    assert.equal(r.apiBytes, body.length);
    assert.equal(r.chunk.n, 8);
    assert.equal(r.startup.n, 2);
    assert.equal(r.logEvents, 10);
    assert.ok(r.snapshotMB > 0);
    assert.equal(seen.starts, 1);
    assert.equal(seen.servedRoom, true, 'the room is copied in while Postbox is down, after its fresh start');
    assert.deepEqual(readdirSync(tmp), [], 'its temp folder is removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('measureSize refuses an /api/state that doesn’t hold the whole room, and still removes its folder', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start } = fakePostbox();
  const body = stateBody(0);
  const get = async () => ({ arrayBuffer: async () => body });
  try {
    await assert.rejects(
      measureSize(30, { runs: 1, requests: 1, chunks: 1, logEvents: 1 }, { start, port: async () => 1, tmp, get }),
      /\/api\/state held 0 of the room’s 30 items/,
    );
    assert.deepEqual(readdirSync(tmp), [], 'its temp folder is removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const summary = (v) => ({ n: 3, p50: v, p95: v * 2, max: v * 3 });
const result = (items) => ({
  items,
  snapshotMB: items / 1000,
  stringify: summary(items / 1000),
  stall: summary(items / 500),
  api: summary(items / 100),
  apiBytes: items * 1000,
  chunk: summary(0.004),
  startup: summary(items / 50),
  logEvents: 5000,
});

test('the report has the command, inputs, commit and machine, and a row a size in each table', () => {
  const report = formatServerReport({
    command: 'node tools/bench-server.mjs --sizes 1000,4000 --runs 3 --requests 20 --chunks 200 --out before-server.md',
    commit: 'abcd1234',
    date: '2026-11-04T00:00:00.000Z',
    machine: { os: 'Linux 6.12', arch: 'x64', cpu: 'Some CPU', node: 'v24.21.0' },
    inputs: { sizes: [1000, 4000], runs: 3, requests: 20, chunks: 200 },
    results: [result(1000), result(4000)],
  });
  assert.match(report, /- Command: `node tools\/bench-server\.mjs --sizes 1000,4000/);
  assert.match(report, /- Commit: abcd1234/);
  assert.match(report, /- Machine: Linux 6\.12, x64, Some CPU; Node v24\.21\.0/);
  assert.match(report, /20 requests a run/);
  for (const title of ['Snapshot stall', '`/api/state`', 'Streamed reply', 'Startup']) assert.match(report, new RegExp(`## ${title}`));
  assert.equal(report.match(/^\| 1,000 \|/gm)?.length, 4, 'the 1× room has a row in each of the four tables');
  assert.equal(report.match(/^\| 4,000 \| 4×/gm)?.length, 4, 'the 4× room too, with its multiple');
  assert.match(report, /\| 1,000 \| 1× \| 1\.00 MB \| 1\.0 ms \| 2\.0 ms \| 4\.0 ms \| 6\.0 ms \| pass \|/);
  assert.match(report, /\| 4,000 \| 4× \| 4,000,000 \| 40\.0 ms \| 80\.0 ms \| 120\.0 ms \|/);
  assert.match(report, /\| 1,000 \| 1× \| 4\.0 µs \| 8\.0 µs \| 12\.0 µs \|/);
});

test('the report fails the stall budget when a size’s worst stall reaches 50 ms', () => {
  const big = { ...result(10000), stall: { n: 3, p50: 30, p95: 49, max: 50 } };
  const report = formatServerReport({
    command: 'c',
    commit: 'c',
    date: 'd',
    machine: { os: 'o', arch: 'a', cpu: 'c', node: 'n' },
    inputs: { sizes: [1000, 10000], runs: 3, requests: 20, chunks: 200 },
    results: [result(1000), big],
  });
  assert.match(report, /\| 10,000 \| 10× \| 10\.00 MB \| 10\.0 ms \| 30\.0 ms \| 49\.0 ms \| 50\.0 ms \| fail \|/);
});
