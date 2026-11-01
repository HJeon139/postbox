// Loading the store from its folder (server/store.mjs; #508’s storage design, “Recovery on load”). There is ONE
// recovery path: recover() reads the snapshot and replays the segments (server/store-replay.mjs) into a PRIVATE
// candidate, a fresh state with the opIds of the commits in the log, touching nothing the store publishes, and load()
// installs it. A commit whose line landed despite a failed fsync is in the candidate at the next start, so its caller’s
// retry with the same opId gets `duplicate`. Retry as a reload (quiesce, candidate, fresh-descriptor barrier, install)
// is 1b’s and will reuse recover() and install().

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
