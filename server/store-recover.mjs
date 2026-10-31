// Loading the store from its folder (server/store.mjs; #508’s storage design, “Recovery on load”). There is ONE
// recovery path: recover() reads the snapshot and replays the segments (server/store-replay.mjs) into a PRIVATE
// candidate, a fresh state with the opIds of the commits in the log, touching nothing the store publishes, and load()
// installs it. A commit whose line landed despite a failed fsync is in the candidate at the next start, so its caller’s
// retry with the same opId gets `duplicate`. Retry as a reload (quiesce, candidate, fresh-descriptor barrier, install)
// is 1b’s and will reuse recover() and install().

import { join } from 'node:path';
import { emptyState, ownState } from '../shared/state.mjs';
import { syncDir, writeSnapshot } from './store-commit.mjs';
import { lockStore, unlockStore } from './store-lock.mjs';
import { replay } from './store-replay.mjs';
import { settledWithin } from './store-retry.mjs';

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
    await syncDir(store).catch((e) => {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(e.code)) throw e;
    });
  } catch (e) {
    await unlockStore(store.io, store.lock);
    store.lock = null;
    throw e;
  }
  return store;
}

/**
 * Flushes, releases the folder and closes this store for good: a late emit or commit (an adapter’s exit callback after
 * shutdown) is refused and never reopens the segment, since another store may hold the folder by then.
 * @param {import('./store.mjs').Store} store
 */
export async function close(store) {
  // The boundary, before any await: from here no Retry starts, no commit or emit is taken, and no destructive step
  // (a torn-tail trim, a snapshot’s rename or pruning) runs on this store’s behalf (gpt’s finding: a Retry started in
  // close()’s first await trimmed the next owner’s line).
  store.closing = true;
  store.cause ??= Object.assign(new Error('The store is closed: Postbox shut it down, so nothing more is saved here.'), { code: 'ECLOSED' });
  try {
    // A Retry or a writer pass under way finishes first, within a bound: closing in the middle would release the lock
    // while a candidate could still install or a snapshot still prune. Past the bound (a disk that never answers) the
    // folder is released anyway, and whatever resumes finds the store retiring and does nothing.
    const inFlight = [store.retrying, store.running].filter(Boolean).map((p) => p.catch(() => {}));
    if (inFlight.length && !(await settledWithin(Promise.all(inFlight), store.retryBoundMs)))
      console.error(`The store closed with a Retry or a write still in flight after ${store.retryBoundMs} ms; it installs nothing from here.`);
    else if (store.writable && store.queue.length)
      await settledWithin(
        store.flush().catch(() => {}),
        store.retryBoundMs,
      );
  } finally {
    store.closed = true;
    store.writable = false;
    store.cause = Object.assign(new Error('The store is closed: Postbox shut it down, so nothing more is saved here.'), { code: 'ECLOSED' });
    await store.fh?.close();
    store.fh = null;
    await unlockStore(store.io, store.lock);
    store.lock = null;
  }
}
