// The data folder Postbox opens at start, moved out of server/index.mjs: the media folder agents copy images to, the
// store, the attachments’ blob folder, and the asset folder’s pass at load (#516 S3).

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sweepAssets } from './asset-orphans.mjs';
import { assetBlobs } from './assets.mjs';
import { sweepDrafts } from './blob-drafts.mjs';
import { Blobs } from './blobs.mjs';
import { Store } from './store.mjs';

/**
 * Opens the data folder: makes its media folder, loads the store under its lock, names the blob folder, removes the
 * drafts a dead Postbox left, and deletes the asset files committed prunes and erases released. Returns
 * the store, the blobs and the media folder, which the server serves under /media/.
 * @param {string} dataDir @param {{ fresh?: boolean }} options  fresh: empty the folder first
 */
export async function openDataFolder(dataDir, { fresh = false } = {}) {
  // Agents copy the images their apps show here; show_app’s description names the variable.
  const mediaDir = join(dataDir, 'media');
  // The store first: a folder a newer Postbox wrote is refused with nothing in it changed (#683).
  const store = await new Store(dataDir).load({ fresh }); // a fresh start empties the folder under the lock
  await mkdir(mediaDir, { recursive: true });
  process.env.POSTBOX_MEDIA = mediaDir;
  const blobs = new Blobs(join(dataDir, 'blobs'));
  // Drafts a killed or crashed Postbox left, before any write can start (server/blob-drafts.mjs, #870).
  await sweepDrafts(blobs.dir);
  await sweepDrafts(join(dataDir, 'assets'));
  // Released asset files go now, under the store’s lock and before any asset write can start (server/asset-orphans.mjs).
  await sweepAssets(store, assetBlobs(dataDir));
  return { store, blobs, mediaDir };
}
