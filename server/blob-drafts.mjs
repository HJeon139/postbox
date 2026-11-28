// Drafts a blob store’s writes leave behind when Postbox is killed, crashes or quits mid-write (#870). A put writes
// `<hash path>.<pid>.<hex>.draft` beside its blob, and a streamed upload `stream.<pid>.<hex>.draft` at the store’s
// root, before renaming it into place. Since #870 an upload has no fixed size, so one left behind can be as large as a
// screen recording, and it counts against the disk space uploads keep free. At start, under the data folder’s lock,
// each draft whose process is no longer running is removed; one of another process still running is kept; one with
// this process’s own pid is a dead Postbox’s, since this one has written none yet.

import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { alive as running } from './store-lock.mjs';

const DRAFT = /\.(\d+)\.[0-9a-f]{8}\.draft$/;

/**
 * Removes the drafts in a blob store whose process isn’t running: at its root and in each two-character folder.
 * Returns how many it removed. A folder that isn’t there yet has none.
 * @param {string} dir @param {{ alive?: (pid: number) => boolean }} [opts]
 */
export async function sweepDrafts(dir, { alive = running } = {}) {
  const top = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = ['', ...top.filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name)).map((e) => e.name)];
  let removed = 0;
  for (const folder of folders) {
    const names = folder ? await readdir(join(dir, folder)).catch(() => []) : top.map((e) => e.name);
    for (const name of names) {
      const pid = Number(name.match(DRAFT)?.[1]);
      // Under the lock, before this process writes, a draft with its own pid is a dead Postbox’s (in a container, node is
      // pid 1 each start).
      if (!pid || (pid !== process.pid && alive(pid))) continue;
      await unlink(join(dir, folder, name)).catch(() => {});
      removed++;
    }
  }
  return removed;
}
