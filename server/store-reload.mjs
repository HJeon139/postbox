// Loading and reloading the store from its folder (server/store.mjs; #508’s storage design, “Recovery on load” and
// “When a write fails”). There is ONE recovery path: recover() reads the snapshot and replays the segments
// (server/store-replay.mjs) into a PRIVATE candidate, a fresh state with the opIds of the commits in the log, and
// touches nothing the store publishes. load() installs the candidate at start. reload() is Retry: a store whose write
// or fsync failed runs it at once (writes are closed meanwhile), and a test runs it by hand. In this order:
//
//   a. quiesce the writer: bump the generation, so a late callback of the old loop (an append or a sync that completes
//      after this) publishes nothing, and close its descriptor; the data-folder lock is kept throughout;
//   b. recover() the candidate, without touching the public state or the epoch;
//   c. open a FRESH descriptor on the retained segment and fsync it, then the folder: a reload reads through the page
//      cache, so a line may be there that a failed fsync never flushed, and a second fsync on the old descriptor can
//      report success without writing it. If that fails, the previous published view stays readable, writes stay
//      closed, and reload() rejects with the cause;
//   d. install the candidate’s state and a new epoch together, tell the reload listeners (the live streams send
//      `resync`), release the held emits onto the new state and reopen writes.
//
// A commit whose line landed despite the fsync error is in the candidate, so its caller’s retry with the same opId
// gets `duplicate`; what a failed write of a plain emit lost is gone with the epoch, which resyncs every page.

import { join } from 'node:path';
import { emptyState, ownState } from '../shared/state.mjs';
import { syncDir, writeSnapshot } from './store-commit.mjs';
import { replay } from './store-replay.mjs';

/**
 * @typedef {{
 *   io: typeof import('node:fs/promises'), dir: string, at: (name: string) => string, segments: () => Promise<{ name: string }[]>,
 *   state: any, ops: Map<string, number>, sinceSnapshot: number, lost: { from: number, to: number, count: number } | null,
 *   segment: string, freshSegment: boolean,
 * }} Candidate  what the folder holds, read without touching the store
 */

/**
 * Reads the folder into a private candidate: the snapshot, then every segment after it. Rejects, changing nothing on
 * disk but a torn tail, when a line is damaged (server/store-replay.mjs).
 * @param {import('./store.mjs').Store} store @returns {Promise<Candidate>}
 */
export async function recover(store) {
  const dir = /** @type {string} */ (store.dir);
  /** @type {Candidate} */
  const c = {
    io: store.io,
    dir,
    at: (name) => join(dir, name),
    segments: () => store.segments(),
    state: emptyState(),
    ops: new Map(),
    sinceSnapshot: 0,
    lost: null,
    segment: '',
    freshSegment: false,
  };
  await readSnapshot(c);
  await replay(c);
  const segs = await c.segments();
  c.segment = segs.at(-1)?.name ?? `events-${c.state.seq + 1}.jsonl`;
  c.freshSegment = !segs.length; // the writer syncs the folder once the first commit lands in a file it made
  return c;
}

/** Reads the snapshot, or once, Stage 2’s store.json as the first snapshot. @param {Candidate} c */
async function readSnapshot(c) {
  const snapPath = c.at('snapshot.json');
  try {
    c.state = ownState({ ...emptyState(), ...JSON.parse(await c.io.readFile(snapPath, 'utf8')) });
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Couldn’t read the snapshot at ${snapPath}: ${e.message}`);
    const legacy = c.at('store.json');
    try {
      c.state = ownState({ ...emptyState(), ...JSON.parse(await c.io.readFile(legacy, 'utf8')) });
      await writeSnapshot(c);
      await c.io.rename(legacy, `${legacy}.migrated`);
    } catch (le) {
      if (le.code !== 'ENOENT') throw new Error(`Couldn’t read the old store at ${legacy}: ${le.message}`);
    }
  }
}

/**
 * Makes the candidate the store’s published view, on a new epoch, with the writer at the end of its last segment and
 * nothing numbered ahead of the state. The since() backlog starts over: a page on the old epoch resyncs anyway.
 * @param {import('./store.mjs').Store} store @param {Candidate} c
 */
export function install(store, c) {
  store.state = c.state;
  store.ops = c.ops;
  store.sinceSnapshot = c.sinceSnapshot;
  store.lost = c.lost;
  store.segment = c.segment;
  store.freshSegment = c.freshSegment;
  store.ahead = 0;
  store.events = [];
  store.epoch = store.newEpoch();
}

/**
 * Retry, in the header’s order. Resolves once writes are open again; rejects with the cause, the store closed and its
 * old view readable, when the folder can’t be read or the fresh descriptor can’t be synced.
 * @param {import('./store.mjs').Store} store
 */
export async function reload(store) {
  store.generation++; // a. the old loop, and any late callback of it, is fenced from here on
  store.running = null;
  const old = store.fh;
  store.fh = null;
  await old?.close().catch(() => {}); // a descriptor whose write failed may refuse to close; it’s let go either way
  /** @type {import('node:fs/promises').FileHandle | null} */
  let fh = null;
  try {
    const c = await recover(store); // b.
    fh = await store.io.open(join(/** @type {string} */ (store.dir), c.segment), 'a'); // c.
    await fh.sync();
    await syncDir(store);
    install(store, c); // d.
  } catch (e) {
    await fh?.close().catch(() => {}); // the segment stays as it was; nothing of the candidate is kept
    closed(store, e);
    throw store.cause;
  }
  store.fh = fh;
  store.writable = true;
  store.cause = null;
  store.warned = false;
  for (const fn of store.reloaders) fn();
  store.pump();
}

/**
 * Keeps the store closed after a reload that failed: the cause names the error’s code, the held emits are released onto
 * the old view (applied and broadcast, not written, as every emit is while the store is closed) and every other queued
 * job is rejected, so nothing waits on a disk that can’t be read back.
 * @param {import('./store.mjs').Store} store @param {Error & { code?: string }} e
 */
function closed(store, e) {
  store.writable = false;
  store.cause = Object.assign(
    new Error(`Postbox couldn’t reload its event log (${e.code ?? 'error'}): ${e.message}. Reads go on; writes stay closed until a reload succeeds.`),
    {
      code: e.code,
      cause: e,
    },
  );
  console.error(store.cause.message);
  const queue = store.queue;
  store.queue = [];
  for (const job of queue) {
    if (job.held) store.release(job);
    else if (job.commit) store.waitingCommits--;
    (job.commit ?? job.flush ?? job.snapshot)?.reject(store.cause);
  }
}
