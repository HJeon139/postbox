// Snapshots, pruning and the folder’s syncs (#508’s storage design, “Snapshots and pruning”; the 1b invariants, I5):
// a snapshot is written in pieces to a temporary file, fsynced, renamed over snapshot.json, then the folder is synced,
// the log rotates to a new segment and the covered segments are deleted. Nothing of it renames or prunes once the store
// is retiring (the integrator’s review of 1a: a snapshot that outlived close() deleted the next store’s segment). Split
// from server/store-commit.mjs under the file-length rule.

import { writeAll } from './store-commit.mjs';
import { snapshotFailed, snapshotSucceeded } from './store-retry.mjs';

const PIECE = 1 << 20; // the snapshot’s text goes to the disk in pieces this long

/**
 * Writes the state to snapshot.json atomically: a temporary file, written in 1 MB pieces (one write of the whole text
 * converts it to bytes in one go, which blocked the loop for about half the snapshot’s time, #508’s storage design,
 * “Snapshots and pruning”), fsynced, then renamed over the snapshot. The caller syncs the folder.
 * @param {{ io: typeof import('node:fs/promises'), at: (name: string) => string, state: any, retiring?: boolean }} store
 */
export async function writeSnapshot(store) {
  const path = store.at('snapshot.json');
  const tmp = `${path}.${process.pid}.tmp`;
  const text = JSON.stringify(store.state);
  const fh = await store.io.open(tmp, 'w');
  try {
    for (let at = 0; at < text.length; ) {
      let end = Math.min(at + PIECE, text.length);
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end++; // a piece never splits a surrogate pair (gpt’s finding)
      await writeAll(fh, Buffer.from(text.slice(at, end)), `The snapshot ${tmp}`);
      at = end;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (store.retiring) {
    await store.io.rm(tmp, { force: true }); // the store is closing: the folder may be another’s before this landed
    throw Object.assign(new Error('The snapshot was abandoned: the store closed while it was written.'), { code: 'ECLOSED' });
  }
  await store.io.rename(tmp, path);
}

/** Makes a rename, or a new segment’s directory entry, durable. @param {{ io: typeof import('node:fs/promises'), dir: string | null }} store */
export async function syncDir(store) {
  const dh = await store.io.open(/** @type {string} */ (store.dir), 'r');
  try {
    await dh.sync();
  } catch (e) {
    // One tolerance everywhere (the integrator’s review of 1a): a filesystem that can’t sync a folder says so with one
    // of these, at load and at every rename alike; any other error is the disk failing.
    if (!TOLERATED_DIR_SYNC.has(e.code)) throw e;
  } finally {
    await dh.close();
  }
}
const TOLERATED_DIR_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR']);

/** A snapshot attempt under the one failure policy (I5): success clears the warning, failure warns and backs off. */
export async function snapshotNow(store) {
  try {
    await takeSnapshot(store);
    snapshotSucceeded(store);
  } catch (e) {
    // An abandonment at close() is not a failed disk: no warning that promises a retry a closed store never makes (critic’s nit on 1b).
    if (e.code !== 'ECLOSED') snapshotFailed(store, e);
    throw e;
  }
}

/**
 * Writes a snapshot, starts a new log segment, and deletes the segments the snapshot covers, once the folder is synced:
 * if that fails, nothing is deleted. Runs in the writer’s loop, so never while a commit is pending, and every event in
 * the covered segments is at or below the snapshot’s seq.
 */
async function takeSnapshot(store) {
  const at = store.state.seq; // the snapshot’s seq: the new segment is named from it, not from a seq advanced meanwhile
  await writeSnapshot(store);
  await syncDir(store);
  if (store.retiring) return; // closing: the rotation and the pruning are left to the next store’s load
  await store.fh?.close();
  store.fh = null;
  const covered = await store.segments();
  store.segment = `events-${at + 1}.jsonl`;
  store.freshSegment = true;
  store.sinceSnapshot = 0;
  store.ops.clear(); // opIds are remembered for the commits newer than the latest snapshot
  for (const seg of covered) if (seg.name !== store.segment && !store.retiring) await store.io.rm(store.at(seg.name), { force: true });
}
