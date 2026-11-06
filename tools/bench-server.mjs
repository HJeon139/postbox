#!/usr/bin/env node
// The server’s numbers by room size (#508, designs/508/storage-design.md): for each size, a big room seeded into a
// temp data folder of its own, and four numbers measured on it, each over --runs runs:
// - the snapshot stall: the longest of the stringify and the event loop’s delay while the server’s writeSnapshot()
//   runs (tools/bench-snapshot-stall.mjs);
// - `/api/state`: each of --requests requests a run to a Postbox started on the room, on a free port, and its bytes;
// - a streamed reply: each `item.text` chunk through the shared reducer, for a reply at the end of the thread;
// - startup: the Store’s load() of the room’s snapshot and a log at the store’s snapshot limit (SNAPSHOT_EVERY).
// Run by hand, not a CI gate. The report (tools/bench-server-report.mjs) gives p50, p95 and max over every run pooled.
//
//   node tools/bench-server.mjs --sizes 1000,4000,10000 --runs 3 --out designs/508/server-report.md

import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SNAPSHOT_EVERY, Store } from '../server/store.mjs';
import { apply } from '../shared/state.mjs';
import { AGENTS, commitOf, count, freePort, hostOf, loadState, seedRoomFolder, THREAD } from './bench-room.mjs';
import { formatServerReport } from './bench-server-report.mjs';
import { measureSnapshotPass, stallOf } from './bench-snapshot-stall.mjs';
import { shownPath } from './key-frame-report.mjs';
import { summarize } from './key-frame-stats.mjs';
import { startPostbox } from './uat/postbox.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The log the startup replays: as long as the store lets one grow before it snapshots. */
export const LOG_EVENTS = SNAPSHOT_EVERY;
const CHUNK = 'part of the streamed reply ';
const STREAMED_ID = 'it_streamed';
const REPLY_EVENTS = 50; // each reply in the log: its item.add and then 49 item.text chunks

/** The options, checked. @param {string[]} argv */
export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sizes: { type: 'string', default: '1000,4000,10000' },
      runs: { type: 'string', default: '3' },
      requests: { type: 'string', default: '20' },
      chunks: { type: 'string', default: '200' },
      out: { type: 'string', default: 'designs/508/server-report.md' },
    },
  });
  return {
    sizes: values.sizes.split(',').map((s) => count('sizes', s.trim())),
    runs: count('runs', values.runs),
    requests: count('requests', values.requests),
    chunks: count('chunks', values.chunks),
    out: resolve(values.out),
  };
}

/**
 * The command as the report shows it: every option spelled out, and --out as shownPath() shows it.
 * @param {ReturnType<typeof options>} o  @param {string} root
 */
export function commandLine(o, root) {
  const args = [`--sizes ${o.sizes.join(',')}`, `--runs ${o.runs}`, `--requests ${o.requests}`, `--chunks ${o.chunks}`];
  return ['node tools/bench-server.mjs', ...args, `--out ${shownPath(o.out, root)}`].join(' ');
}

/** The count, p50, p95 and max of one measure over every run’s values pooled. @param {Record<string, number[]>[]} runs  @param {string} key */
export function pooled(runs, key) {
  return summarize(runs.flatMap((r) => r[key]));
}

/**
 * Adds an agent’s reply at the end of the thread and streams `chunks` chunks into it through the reducer, as the
 * server applies each `item.text` event. Each chunk’s time, in ms. Changes the state it is given.
 * @param {any} state  @param {string} threadId  @param {number} chunks
 */
export function streamChunks(state, threadId, chunks) {
  const id = STREAMED_ID;
  apply(state, 'item.add', { threadId, item: { id, kind: 'agent', handle: AGENTS[0], text: '' } });
  const times = [];
  for (let i = 0; i < chunks; i++) {
    const t0 = performance.now();
    apply(state, 'item.text', { threadId, id, text: CHUNK });
    times.push(performance.now() - t0);
  }
  return times;
}

/**
 * Snapshots the room in a data folder, then appends `events` events after it, as streamed replies, so a load reads the
 * snapshot and replays them all. @param {string} data  @param {number} [events]
 */
export async function writeLog(data, events = LOG_EVENTS) {
  const store = await new Store(data, { snapshotEvery: Number.POSITIVE_INFINITY }).load();
  await store.snapshot();
  let id = '';
  for (let i = 0; i < events; i++) {
    if (i % REPLY_EVENTS === 0) {
      id = `it_log${i}`;
      store.emit('item.add', { threadId: THREAD, item: { id, kind: 'agent', handle: AGENTS[0], text: '' } });
    } else {
      store.emit('item.text', { threadId: THREAD, id, text: CHUNK });
    }
  }
  await store.close();
}

/** The startup’s load: a Store of the folder, loaded. @param {string} dir */
const loadStore = (dir) => new Store(dir).load();

/**
 * One run of the in-process numbers: a snapshot pass, a streamed reply on a copy of the state, a load of the log.
 * snapshotPass is measureSnapshotPass(), or a test’s stand-in; openStore loads a Store, or a test’s stand-in; stream
 * is streamChunks(), or a test’s stand-in.
 */
async function inProcessRun(state, boot, scratch, chunks, { snapshotPass, openStore, stream }) {
  const pass = await snapshotPass(state, scratch);
  const copy = structuredClone(state);
  const chunk = stream(copy, THREAD, chunks);
  const thread = copy.items[THREAD] ?? [];
  const reply = thread.find((item) => item.id === STREAMED_ID);
  const streamed = { replyChars: reply?.text.length ?? 0, threadItems: thread.length };
  const t0 = performance.now();
  const store = await openStore(boot);
  const startup = performance.now() - t0;
  // What the load did, read before close: the events it replayed after the snapshot, and the room it holds.
  const replayed = store.sinceSnapshot;
  const loadedItems = store.state.items[THREAD]?.length ?? 0;
  await store.close();
  const run = { stall: [stallOf(pass)], stringify: [pass.stringifyMs], chunk, startup: [startup], bytes: pass.bytes };
  return { ...run, replayed, loadedItems, streamed };
}

/**
 * Refuses a streamed reply that didn’t land, whole, in the room’s thread: chunks streamed into another thread, or into
 * an empty state, are as fast, and would read as a fast reducer (critic’s pass on #783). O(1).
 * @param {{ replyChars: number, threadItems: number }} streamed  @param {number} chunks  @param {number} items
 */
export function checkStream(streamed, chunks, items) {
  const chars = chunks * CHUNK.length;
  if (streamed.replyChars !== chars) throw new Error(`The streamed reply holds ${streamed.replyChars} of its ${chars} characters.`);
  if (streamed.threadItems < items + 1) throw new Error(`The thread held ${streamed.threadItems} items with the reply, not ${items + 1}.`);
}

/**
 * Refuses a startup that didn’t replay the log it was given, or didn’t load the room: a load of the wrong folder, or of
 * a missing log, is fast, and would read as a fast startup (the integrator’s review of #783).
 * @param {{ replayed: number, loadedItems: number }} run  @param {number} logEvents  @param {number} items
 */
export function checkReplay(run, logEvents, items) {
  if (run.replayed !== logEvents) throw new Error(`The startup replayed ${run.replayed} of the log’s ${logEvents} events.`);
  if (run.loadedItems < items) throw new Error(`The startup loaded ${run.loadedItems} of the room’s ${items} items.`);
}

/**
 * Each `/api/state` request’s time on a Postbox serving a copy of the room, and the body’s bytes. startPostbox()
 * starts fresh, which empties its folder, so the room is copied in while it’s down, as the key-to-frame bench seeds
 * it; a body that doesn’t hold the whole room is refused, so an empty room can’t read as a fast one.
 * @param {string} room  @param {number} items  @param {number} total
 */
async function apiRuns(room, items, total, { start, port, get }) {
  const data = `${room}-served`;
  const postbox = await start({ root: ROOT, port: await port(), data, env: { POSTBOX_BACKENDS: 'mock' }, log: () => {} });
  const times = [];
  let body = Buffer.alloc(0);
  try {
    await postbox.restart({ whileDown: () => cp(room, data, { recursive: true }) });
    for (let i = 0; i < total; i++) {
      const t0 = performance.now();
      const res = await get(`${postbox.origin}/api/state`);
      body = Buffer.from(await res.arrayBuffer());
      times.push(performance.now() - t0);
    }
  } finally {
    await postbox.kill();
  }
  const served = JSON.parse(body.toString()).state?.items?.[THREAD]?.length ?? 0;
  if (served !== items) throw new Error(`/api/state held ${served} of the room’s ${items} items.`);
  return { times, bytes: body.length };
}

/**
 * One size: the room seeded into a temp folder, and a copy of it with the log for the startup; the in-process numbers
 * a run at a time, after one warm-up snapshot; then `/api/state`. The folder is removed however it ends. start, port,
 * tmp, get, snapshotPass and openStore are for tests; logEvents too.
 * @param {number} items  @param {{ runs: number, requests: number, chunks: number, logEvents?: number }} o
 */
export async function measureSize(items, o, deps = {}) {
  const {
    start = startPostbox,
    port = freePort,
    tmp = tmpdir(),
    get = fetch,
    snapshotPass = measureSnapshotPass,
    openStore = loadStore,
    stream = streamChunks,
  } = deps;
  const dir = await mkdtemp(join(tmp, `pb-bench-server-${items}-`));
  const room = join(dir, 'room');
  const boot = join(dir, 'boot');
  const scratch = join(dir, 'scratch');
  const logEvents = o.logEvents ?? LOG_EVENTS;
  try {
    await seedRoomFolder(room, items);
    await cp(room, boot, { recursive: true });
    await writeLog(boot, logEvents);
    await mkdir(scratch); // where the snapshot passes write, and remove what they wrote
    const state = await loadState(room);
    await snapshotPass(state, scratch);
    const runs = [];
    for (let run = 0; run < o.runs; run++) {
      const one = await inProcessRun(state, boot, scratch, o.chunks, { snapshotPass, openStore, stream });
      checkReplay(one, logEvents, items);
      checkStream(one.streamed, o.chunks, items);
      runs.push(one);
    }
    const api = await apiRuns(room, items, o.runs * o.requests, { start, port, get });
    return {
      items,
      snapshotMB: runs[0].bytes / (1024 * 1024),
      stringify: pooled(runs, 'stringify'),
      stall: pooled(runs, 'stall'),
      api: summarize(api.times),
      apiBytes: api.bytes,
      chunk: pooled(runs, 'chunk'),
      startup: pooled(runs, 'startup'),
      logEvents: runs[0].replayed,
      replayed: runs.map((r) => r.replayed),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What a Ctrl-C or a SIGTERM must wait for: the size being measured, whose own finally stops its Postbox and removes
 * its folder; and whether the bench is stopping, so no further size starts.
 * @typedef {{ size: Promise<any> | null, stopping: boolean }} Live
 */

/**
 * Every size, one after another, in the order given, until the bench is stopping. Each size in progress is kept in
 * live, for a stop to wait for.
 * @param {{ sizes: number[] }} o  @param {(items: number) => Promise<any>} measure  @param {Live} [live]
 */
export async function measureAll(o, measure, live = { size: null, stopping: false }) {
  const results = [];
  for (const items of o.sizes) {
    if (live.stopping) break;
    live.size = measure(items);
    results.push(await live.size);
  }
  return results;
}

/**
 * The stop for a signal: marks the bench stopping, waits for the size in progress to finish or fail, so its finally
 * removes its folder and stops its Postbox, and exits as a shell reports the signal: 130 for SIGINT, 143 for SIGTERM.
 * Exiting at once skipped that finally. exit is for tests.
 * @param {Live} live  @param {(code: number) => void} [exit]
 */
export function stopper(live, exit = process.exit) {
  return async (/** @type {'SIGINT' | 'SIGTERM'} */ signal) => {
    if (live.stopping) return;
    live.stopping = true;
    await Promise.resolve(live.size).catch(() => null);
    exit(signal === 'SIGINT' ? 130 : 143);
  };
}

/**
 * Writes text to path whole: to a file beside it first, then renamed over it, so a reader or a stop never sees part
 * of it. fs is for tests.
 * @param {string} path  @param {string} text  @param {{ writeFile: typeof writeFile, rename: typeof rename }} [fs]
 */
export async function writeWhole(path, text, fs = { writeFile, rename }) {
  const draft = `${path}.tmp`;
  await fs.writeFile(draft, text);
  await fs.rename(draft, path);
}

/** @type {Live} */
const live = { size: null, stopping: false };

async function main() {
  const o = options(process.argv.slice(2));
  const stop = stopper(live);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(signal, () => void stop(signal));
  const results = await measureAll(
    o,
    async (items) => {
      const r = await measureSize(items, o);
      console.log(`${items.toLocaleString('en-US')} items: measured ${o.runs} runs.`);
      return r;
    },
    live,
  );
  // Stopped by a signal: the stop exits with the signal’s code, and no report is written from part of the sizes.
  if (live.stopping) return;
  const report = formatServerReport({
    command: commandLine(o, ROOT),
    commit: commitOf(ROOT),
    date: new Date().toISOString(),
    machine: hostOf(),
    inputs: { sizes: o.sizes, runs: o.runs, requests: o.requests, chunks: o.chunks },
    results,
  });
  // A signal now waits for the write, as it does for a size, so it never leaves half a report.
  live.size = writeWhole(o.out, report);
  await live.size;
  console.log(`Wrote ${shownPath(o.out, ROOT)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    // Stopped by a signal: the stop exits with the signal’s code once the size has cleaned up.
    if (live.stopping) return;
    console.error(e.message);
    process.exit(1);
  });
