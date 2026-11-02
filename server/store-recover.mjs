// Loading the store from its folder (server/store.mjs; #508’s storage design, “Recovery on load”). There is ONE
// recovery path: recover() reads the snapshot and replays the segments (server/store-replay.mjs) into a PRIVATE
// candidate, a fresh state with the opIds of the commits in the log, touching nothing the store publishes, and load()
// installs it. A commit whose line landed despite a failed fsync is in the candidate at the next start, so its caller’s
// retry with the same opId gets `duplicate`. Retry as a reload (quiesce, candidate, fresh-descriptor barrier, install)
// is 1b’s and will reuse recover() and install().

import { join } from 'node:path';
import { emptyState, ownState } from '../shared/state.mjs';
import { lockStore, unlockStore } from './store-lock.mjs';
import { replay } from './store-replay.mjs';
import { settledWithin } from './store-retry.mjs';
import { syncDir, writeSnapshot } from './store-snapshot.mjs';

/**
 * @typedef {{
 *   io: typeof import('node:fs/promises'), dir: string, at: (name: string) => string, segments: () => Promise<{ name: string }[]>,
 *   state: any, ops: Map<string, number>, sinceSnapshot: number, lost: { from: number, to: number, count: number } | null,
 *   segment: string, freshSegment: boolean, retiring: boolean,
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
    get retiring() {
      return store.retiring; // the candidate stops touching the disk the moment the store begins to close
    },
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
      if (c.retiring) return;
      await c.io.rename(legacy, `${legacy}.migrated`);
      await syncDir(c); // both renames durable before the old file is taken as read
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
  // The state object keeps its identity: the runtime and the ledger hold it. Its collections are the candidate’s, so a
  // sub-object held across the install is stale (the 1b invariants, I3a).
  for (const key of Object.keys(store.state)) delete store.state[key];
  Object.assign(store.state, c.state);
  store.ops = c.ops;
  store.sinceSnapshot = c.sinceSnapshot;
  store.lost = c.lost;
  store.segment = c.segment;
  store.freshSegment = c.freshSegment;
  store.ahead = 0;
  store.held = 0;
  store.heldLog = []; // with held and the queue, so no pending read sees a job of the old history
  store.views.clear();
  store.waitingCommits = 0;
  store.queue = [];
  store.events = [];
  store.writtenThrough = store.state.seq;
  store.savedThrough = store.state.seq;
  store.epoch = store.newEpoch();
}

/**
 * Takes the folder (one store per folder, or it rejects naming the holder), reads it, and leaves the writer at its end.
 * @param {import('./store.mjs').Store} store @param {{ fresh?: boolean }} [options]
 */
export async function load(store, { fresh = false } = {}) {
  if (!store.dir) {
    store.epoch = store.newEpoch();
    return store;
  }
  await store.io.mkdir(store.dir, { recursive: true });
  store.lock = await lockStore(store.io, store.dir);
  try {
    // A fresh start empties the folder only once it holds the lock, so a running Postbox’s files are never deleted
    // under it (the integrator’s review of 1a).
    if (fresh)
      for (const n of await store.io.readdir(store.dir))
        if (/^(store\.json|snapshot\.json|events-\d+\.jsonl)/.test(n)) await store.io.rm(store.at(n), { force: true });
    install(store, await recover(store));
    // The folder’s entries are made durable once per start: a segment rotated by an earlier run that only ever held
    // emits may never have had its entry synced (the integrator’s review of 1a). A filesystem that can’t sync a
    // folder is tolerated; any other error refuses the start.
    await syncDir(store); // its own tolerance for a filesystem that can’t sync a folder (one set, everywhere)
  } catch (e) {
    await unlockStore(store.io, store.lock);
    store.lock = null;
    throw e;
  }
  return store;
}

/**
 * Waits for what is under way: a Retry, a writer pass, a reconciliation an earlier Retry detached. Re-read after each
 * wait, since a Retry that times out meanwhile hands its still-running listener to lateReconcile after the first
 * reading (gpt’s finding on 1b); ends when a reading shows nothing new. Whether all of it settled within the bound.
 * @param {import('./store.mjs').Store} store
 */
async function drained(store) {
  let seen = new Set();
  for (;;) {
    const now = [store.retrying, store.running, store.lateReconcile].filter(Boolean);
    const fresh = now.filter((p) => !seen.has(p));
    if (!fresh.length) return true;
    seen = new Set([...seen, ...fresh]);
    if (!(await settledWithin(Promise.all(fresh.map((p) => p.catch(() => {}))), store.retryBoundMs))) return false;
  }
}

const CLOSED = () => Object.assign(new Error('The store is closed: Postbox shut it down, so nothing more is saved here.'), { code: 'ECLOSED' });

/**
 * Flushes, releases the folder and closes this store for good: a late emit or commit (an adapter’s exit callback after
 * shutdown) is refused and never reopens the segment, since another store may hold the folder by then. Rejects, with
 * the lock KEPT, when a Retry or a write under way hasn’t settled within the bound.
 * @param {import('./store.mjs').Store} store
 */
export async function close(store) {
  // The boundary, before any await: from here no Retry starts, no commit or emit is taken, and no destructive step
  // (a torn-tail trim, a snapshot’s rename or pruning) runs on this store’s behalf (gpt’s finding: a Retry started in
  // close()’s first await trimmed the next owner’s line).
  store.closing = true;
  store.cause ??= CLOSED();
  // A Retry or a writer pass under way finishes first, then the queue is flushed (flush() is the one path still open
  // on a closing store), each within a bound. The bound decides only what the caller is told: a flag can’t cancel a
  // write or a rename already handed to the disk, so past it the lock is KEPT and close() rejects (gpt’s and critic’s
  // I3c point). The process’s exit releases the lock, and the next start takes over the stale record.
  let quiet = await drained(store);
  // The final flush runs whenever writes are open, queue or no queue: an emit is appended without a sync, so a drained
  // queue still leaves an acknowledged line unsynced (gpt’s finding), and the flush is the sync. Its failure is the
  // caller’s to hear, not swallowed.
  /** @type {(Error & { code?: string, cause?: Error }) | null} */
  let failed = null;
  if (quiet && store.writable) {
    const flushed = store.flush().then(
      () => null,
      (e) => e,
    );
    quiet = await settledWithin(flushed, store.retryBoundMs);
    if (quiet) failed = await flushed;
  }
  store.closed = true;
  store.writable = false;
  if (!quiet || failed) {
    const why = failed
      ? `its last sync failed (${failed.code ?? 'error'}): ${(failed.cause ?? failed).message}, so the log may not be durable`
      : `a write or Retry is still in flight after ${store.retryBoundMs} ms and the disk isn’t answering`;
    store.cause = Object.assign(
      new Error(`The store can’t close: ${why}. Stop the process; its lock on the folder goes with it, and the next start takes the folder over.`),
      {
        code: failed?.code ?? 'EBUSY',
        cause: failed ?? undefined,
      },
    );
    console.error(store.cause.message);
    throw store.cause;
  }
  store.cause = CLOSED();
  try {
    await store.fh?.close();
  } catch (e) {
    console.error(`The event log’s descriptor didn’t close cleanly: ${e.message}`); // the lock is released either way (1a’s fix)
  } finally {
    store.fh = null;
    await unlockStore(store.io, store.lock);
    store.lock = null;
  }
}
