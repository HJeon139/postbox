// The asset folder’s pass at load (#516 S3, designs/architecture.md, “Assets”), after the store holds its folder and has
// read the log, before any tool accepts a write. A file is deleted only on positive evidence: a committed prune or
// erase released its hash (assetReleases), and no version in any room still keeps it. A file nothing names and nothing
// released (a write that never committed, or metadata an older Postbox dropped) is kept and counted, never deleted:
// deleting by absence would turn any version the state lost into bytes lost for good. Only at load, since deleting
// while Postbox runs could race a write of the same bytes, which finds the file already there (server/blobs.mjs).

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The hashes the state’s asset versions name: `kept` only those not pruned, `all` every one. @param {any} state */
function namedHashes(state) {
  const kept = new Set();
  const all = new Set();
  for (const asset of Object.values(state.assets ?? {}))
    for (const x of asset.versions) {
      if (!x.sha256) continue;
      all.add(x.sha256);
      if (!x.pruned) kept.add(x.sha256);
    }
  return { kept, all };
}

/** Every file in the asset folder, as { name, path }: a blob’s name is its hash, a draft’s more. @param {string} dir */
async function filesIn(dir) {
  const out = [];
  const folders = await readdir(dir).catch((e) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  for (const f of folders) {
    if (!/^[a-f0-9]{2}$/.test(f)) continue;
    for (const n of await readdir(join(dir, f))) out.push({ name: f + n, path: join(dir, f, n) });
  }
  return out;
}

/**
 * Deletes the released files no version keeps, then drops their hashes, and every released hash a version keeps again,
 * from assetReleases in one commit. A crash between the two deletes nothing twice and loses nothing: the next load
 * finds the file gone and drops the hash then.
 * @param {import('./store.mjs').Store} store @param {import('./blobs.mjs').Blobs} blobs
 * @param {{ warn?: (line: string) => void }} [log]
 * @returns {Promise<{ deleted: string[], unclaimed: { count: number, bytes: number } }>}
 */
export async function sweepAssets(store, blobs, { warn = console.warn } = {}) {
  const { kept, all } = namedHashes(store.state);
  const released = Object.keys(store.state.assetReleases ?? {});
  const deleted = [];
  const done = [];
  for (const sha of released) {
    if (!kept.has(sha)) {
      try {
        await unlink(blobs.pathOf(sha));
      } catch (e) {
        if (/** @type {any} */ (e).code !== 'ENOENT') {
          warn(`Postbox couldn’t delete a released asset file, ${sha}: ${e instanceof Error ? e.message : e}. It tries again at the next start.`);
          continue;
        }
      }
      deleted.push(sha);
    }
    done.push(sha);
  }
  if (done.length) {
    await store
      .commit([{ type: 'asset.released', data: { hashes: done } }])
      .catch((e) => warn(`Postbox deleted released asset files but couldn’t record it: ${e.message}. The next start records it.`));
  }
  const unclaimed = { count: 0, bytes: 0 };
  for (const f of await filesIn(blobs.dir)) {
    if (all.has(f.name) || released.includes(f.name)) continue; // named, or released and not deleted yet
    unclaimed.count++;
    unclaimed.bytes += (await stat(f.path)).size;
  }
  if (unclaimed.count)
    warn(
      `Postbox found ${unclaimed.count} file${unclaimed.count === 1 ? '' : 's'} (${unclaimed.bytes} bytes) in the asset folder that no asset names: writes that never committed, or assets an older Postbox dropped. They’re kept.`,
    );
  return { deleted, unclaimed };
}
