// The asset folder’s pass at load (#516 S3, designs/architecture/assets.md, “Assets”), after the store holds its folder and has
// read the log, before any tool accepts a write. A file is deleted only on positive evidence: a committed prune or
// erase released its hash (assetReleases), and no version in any room still keeps it, by the rooms’ indexes and by a
// recount of the versions themselves (#691). A file nothing names and nothing
// released (a write cut off before its commit, or metadata an older Postbox dropped) is kept and counted, never deleted:
// deleting by absence would turn any version the state lost into bytes lost for good. The load deletes only released
// files; while Postbox runs, the one delete is a refused write removing the file it made, which the store’s holds keep
// from racing a write of the same bytes (server/blobs.mjs, #706).

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The hashes some room’s unpruned versions keep, from the rooms’ indexes (shared/state-assets.mjs). @param {any} state */
const keptHashes = (state) => new Set(Object.values(state.assetRooms ?? {}).flatMap((index) => Object.keys(index.files)));

/**
 * The hashes the unpruned versions keep, counted from the versions themselves, each with the first room seen keeping
 * it: once per load, so a delete never rests on the indexes alone (#691). @param {any} state @returns {Map<string, string>}
 */
function recountKept(state) {
  const kept = new Map();
  for (const asset of Object.values(state.assets ?? {}))
    for (const x of asset.versions) if (x.sha256 && !x.pruned && !kept.has(x.sha256)) kept.set(x.sha256, asset.room);
  return kept;
}

/** Every file in the asset folder, as { name, path }: a blob’s name is its hash, a draft’s more. @param {string} dir */
async function filesIn(dir) {
  const entries = await readdir(dir).catch((e) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  const folders = entries.filter((f) => /^[a-f0-9]{2}$/.test(f));
  const filesOf = async (f) => (await readdir(join(dir, f))).map((n) => ({ name: f + n, path: join(dir, f, n) }));
  return (await Promise.all(folders.map(filesOf))).flat();
}

/** The log’s line for files nothing names: how many, how big, where they come from, and that they stay. */
function unclaimedLine({ count, bytes }) {
  const files = count === 1 ? '1 file' : `${count} files`;
  const why = 'writes that never committed, or assets an older Postbox dropped';
  return `Postbox found ${files} (${bytes} bytes) in the asset folder that no asset names: ${why}. They’re kept.`;
}

/**
 * Deletes a released file, and says whether it’s gone: deleted now, or already. Any other failure keeps it released,
 * for the next load to try again. @returns {Promise<boolean>}
 */
async function removed(blobs, sha, warn) {
  try {
    await unlink(blobs.pathOf(sha));
    return true;
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return true;
    warn(`Postbox couldn’t delete a released asset file, ${sha}: ${e instanceof Error ? e.message : e}. It tries again at the next start.`);
    return false;
  }
}

/**
 * Deletes the released files no version keeps, then drops their hashes, and every released hash a version keeps again,
 * from assetReleases in one commit. A crash between the two deletes nothing twice and loses nothing: the next load
 * finds the file gone and drops the hash then. Files nothing keeps and nothing released are counted, never deleted.
 * @param {import('./store.mjs').Store} store @param {import('./blobs.mjs').Blobs} blobs
 * @param {{ warn?: (line: string) => void }} [log]
 * @returns {Promise<{ deleted: string[], unclaimed: { count: number, bytes: number } }>}
 */
export async function sweepAssets(store, blobs, { warn = console.warn } = {}) {
  const kept = keptHashes(store.state);
  const counted = recountKept(store.state);
  const released = new Set(Object.keys(store.state.assetReleases ?? {}));
  // Deleting can't be undone: a released file goes only when the index and the recount agree nothing keeps it. Where
  // they disagree, it stays, released, and the log says which, for the next load to decide again.
  for (const sha of released)
    if (!kept.has(sha) && counted.has(sha))
      warn(
        `Postbox kept a released asset file, ${sha}: room ${counted.get(sha)}’s index says no version keeps it, but a version there does. It isn’t deleted.`,
      );
  const toDelete = [...released].filter((sha) => !kept.has(sha) && !counted.has(sha));
  const gone = await Promise.all(toDelete.map((sha) => removed(blobs, sha, warn)));
  const deleted = toDelete.filter((_, i) => gone[i]);
  const done = [...[...released].filter((sha) => kept.has(sha)), ...deleted];
  if (done.length) {
    const note = (e) => warn(`Postbox deleted released asset files but couldn’t record it: ${e.message}. The next start records it.`);
    await store.commit([{ type: 'asset.released', data: { hashes: done } }]).catch(note);
  }
  const strays = (await filesIn(blobs.dir)).filter((f) => !kept.has(f.name) && !released.has(f.name));
  const sizes = await Promise.all(strays.map(async (f) => (await stat(f.path)).size));
  const unclaimed = { count: strays.length, bytes: sizes.reduce((sum, n) => sum + n, 0) };
  if (unclaimed.count) warn(unclaimedLine(unclaimed));
  return { deleted, unclaimed };
}
