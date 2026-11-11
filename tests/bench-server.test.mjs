// Tests for tools/bench-server.mjs and tools/bench-server-report.mjs (#508): its options, the pooling of runs into
// percentiles, the streamed reply, the log at the store’s snapshot limit, one size measured on fakes, and the report.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SNAPSHOT_EVERY, Store } from '../server/store.mjs';
import { parseSnapshotText } from '../server/store-snapshot-lines.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { seedRoomFolder, THREAD } from '../tools/bench-room.mjs';
import { checkReplay, checkStream, commandLine, LOG_EVENTS, measureSize, options, pooled, streamChunks, writeLog } from '../tools/bench-server.mjs';
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

test('writeLog leaves a snapshot of the room and a log of LOG_EVENTS events after it', async () => {
  const data = mkdtempSync(join(tmpdir(), 'pb-bench-log-'));
  try {
    await seedRoomFolder(data, 20);
    await writeLog(data, 50);
    const segments = readdirSync(data).filter((n) => /^events-\d+\.jsonl$/.test(n));
    assert.equal(segments.length, 1);
    const lines = readFileSync(join(data, segments[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 50);
    const snap = parseSnapshotText(readFileSync(join(data, 'snapshot.json'), 'utf8'));
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
 * whileDown; it records whether the folder held the room once it was back up, and each kill.
 */
function fakePostbox() {
  const seen = { starts: 0, kills: 0, servedRoom: false };
  const start = async (/** @type {{ data: string }} */ o) => {
    seen.starts++;
    rmSync(o.data, { recursive: true, force: true });
    mkdirSync(o.data);
    return {
      origin: 'http://127.0.0.1:1',
      kill: async () => {
        seen.kills++;
      },
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

test('a startup that replayed less than its log, or loaded less than its room, is refused', () => {
  assert.doesNotThrow(() => checkReplay({ replayed: 10, loadedItems: 30 }, 10, 30));
  assert.throws(() => checkReplay({ replayed: 0, loadedItems: 30 }, 10, 30), /replayed 0 of the log’s 10 events/);
  assert.throws(() => checkReplay({ replayed: 10, loadedItems: 0 }, 10, 30), /loaded 0 of the room’s 30 items/);
});

test('a streamed reply that didn’t land in the room’s thread, whole, is refused', () => {
  assert.doesNotThrow(() => checkStream({ replyChars: 270, threadItems: 31 }, 10, 30));
  assert.throws(() => checkStream({ replyChars: 0, threadItems: 31 }, 10, 30), /streamed reply holds 0 of its 270 characters/);
  assert.throws(() => checkStream({ replyChars: 270, threadItems: 1 }, 10, 30), /thread held 1 items with the reply, not 31/);
  assert.throws(() => checkStream({ replyChars: 270, threadItems: 30 }, 10, 30), /thread held 30 items with the reply, not 31/);
});

test('measureSize refuses a startup that replayed its log but loaded no room', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start } = fakePostbox();
  const get = async () => ({ arrayBuffer: async () => stateBody(30) });
  const openStore = async () => ({ sinceSnapshot: 10, state: { items: { [THREAD]: [] } }, close: async () => {} });
  try {
    const o = { runs: 1, requests: 1, chunks: 1, logEvents: 10 };
    await assert.rejects(measureSize(30, o, { start, port: async () => 1, tmp, get, openStore }), /loaded 0 of the room’s 30 items/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('measureSize refuses chunks streamed into another thread, and still removes its folder', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start } = fakePostbox();
  const get = async () => ({ arrayBuffer: async () => stateBody(30) });
  const stream = (/** @type {any} */ state, /** @type {string} */ _thread, /** @type {number} */ chunks) => streamChunks(state, 'th_other', chunks);
  try {
    const o = { runs: 1, requests: 1, chunks: 2, logEvents: 10 };
    await assert.rejects(measureSize(30, o, { start, port: async () => 1, tmp, get, stream }), /streamed reply holds 0 of its/);
    assert.deepEqual(readdirSync(tmp), [], 'its temp folder is removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('measureSize refuses a startup that replayed nothing, and still removes its folder', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start } = fakePostbox();
  const get = async () => ({ arrayBuffer: async () => stateBody(30) });
  const openStore = async () => ({ sinceSnapshot: 0, state: { items: { [THREAD]: [] } }, close: async () => {} });
  try {
    const o = { runs: 1, requests: 1, chunks: 1, logEvents: 10 };
    await assert.rejects(measureSize(30, o, { start, port: async () => 1, tmp, get, openStore }), /replayed 0 of the log’s 10 events/);
    assert.deepEqual(readdirSync(tmp), [], 'its temp folder is removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

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
    assert.ok(r.startup.max > 0, 'each startup is timed, not set');
    assert.equal(r.logEvents, 10, 'the events the startup replayed, as measured');
    assert.deepEqual(r.replayed, [10, 10], 'each run’s load replayed the whole log');
    assert.ok(r.snapshotMB > 0);
    assert.equal(seen.starts, 1);
    assert.equal(seen.kills, 1, 'its Postbox is stopped');
    assert.equal(seen.servedRoom, true, 'the room is copied in while Postbox is down, after its fresh start');
    assert.deepEqual(readdirSync(tmp), [], 'its temp folder is removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * A stand-in for measureSnapshotPass() that records each pass, the state it was given and that state’s JSON then,
 * and returns the pass’s number as its stringify time, so a pooled value shows which passes were pooled.
 */
function recordingPass() {
  const passes = [];
  const snapshotPass = async (/** @type {any} */ state) => {
    passes.push({ state, json: JSON.stringify(state) });
    return { bytes: 100, stringifyMs: passes.length, maxDelay: 0, timerDelay: 0 };
  };
  return { snapshotPass, passes };
}

test('measureSize runs one warm-up snapshot pass before the runs, and pools only the runs', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start } = fakePostbox();
  const { snapshotPass, passes } = recordingPass();
  const body = stateBody(30);
  const get = async () => ({ arrayBuffer: async () => body });
  try {
    const o = { runs: 2, requests: 1, chunks: 1, logEvents: 1 };
    const r = await measureSize(30, o, { start, port: async () => 1, tmp, get, snapshotPass });
    assert.equal(passes.length, 3, 'one warm-up pass and one a run');
    assert.deepEqual(r.stringify, { n: 2, p50: 2, p95: 3, max: 3 }, 'the first pass, the warm-up, isn’t pooled');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('measureSize streams its chunks into a copy, leaving the state the snapshot passes measure unchanged', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start } = fakePostbox();
  const { snapshotPass, passes } = recordingPass();
  const body = stateBody(30);
  const get = async () => ({ arrayBuffer: async () => body });
  try {
    const o = { runs: 2, requests: 1, chunks: 3, logEvents: 1 };
    await measureSize(30, o, { start, port: async () => 1, tmp, get, snapshotPass });
    const [first, ...rest] = passes;
    assert.equal(first.state.items[THREAD].length, 30);
    assert.equal(JSON.stringify(first.state), first.json, 'the state is as it was before the chunk runs');
    for (const pass of rest) assert.equal(pass.state, first.state, 'every pass measures the same state');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('measureSize refuses an /api/state that doesn’t hold the whole room, and still removes its folder', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pb-bench-size-'));
  const { start, seen } = fakePostbox();
  const body = stateBody(0);
  const get = async () => ({ arrayBuffer: async () => body });
  try {
    await assert.rejects(
      measureSize(30, { runs: 1, requests: 1, chunks: 1, logEvents: 1 }, { start, port: async () => 1, tmp, get }),
      /\/api\/state held 0 of the room’s 30 items/,
    );
    assert.equal(seen.kills, 1, 'its Postbox is stopped before the refusal');
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
  assert.match(report, /Each `item\.text` chunk through the shared reducer \(shared\/state\.mjs\), for a reply added at the end of the thread\.\n/);
  assert.doesNotMatch(report, /by a scan/, 'the report doesn’t say how the reducer finds the item');
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
