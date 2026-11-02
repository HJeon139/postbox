// The data folder Postbox opens at start, moved out of server/index.mjs: the media folder agents copy images to, the
// store, and the attachments’ blob folder.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Blobs } from './blobs.mjs';
import { Store } from './store.mjs';

/**
 * Opens the data folder: makes its media folder, loads the store under its lock, and names the blob folder. Returns
 * the store, the blobs and the media folder, which the server serves under /media/.
 * @param {string} dataDir @param {{ fresh?: boolean }} options  fresh: empty the folder first
 */
export async function openDataFolder(dataDir, { fresh = false } = {}) {
  // Agents copy the images their apps show here; show_app’s description names the variable.
  const mediaDir = join(dataDir, 'media');
  await mkdir(mediaDir, { recursive: true });
  process.env.POSTBOX_MEDIA = mediaDir;
  const store = await new Store(dataDir).load({ fresh }); // a fresh start empties the folder under the lock
  const blobs = new Blobs(join(dataDir, 'blobs'));
  return { store, blobs, mediaDir };
}
