// One store per data folder (#508’s design, “Storage”): load() takes an exclusive lock file there, with the pid of the
// process holding it, so two stores can’t interleave their lines in one log, whatever started them. The command line
// claims a folder too (server/home.mjs, lockData, for bin/postbox.mjs), but a store opened by anything else (a tool, a
// test) bypasses that; this lock is the one that counts. A lock whose process is gone is stale and taken over.
// close() releases it. A second store in the same process is refused too: the pid is alive, and it’s another writer.

import { join } from 'node:path';

export const LOCK = 'store.lock';

/** Whether a process is running: a signal of 0 checks without sending one, and EPERM means it’s there but not ours. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Takes the folder’s lock for this process, or rejects naming the folder and the pid holding it.
 * @param {typeof import('node:fs/promises')} io @param {string} dir
 * @returns {Promise<string>} the lock file’s path, for unlockStore
 */
export async function lockStore(io, dir) {
  const lock = join(dir, LOCK);
  for (let tries = 0; tries < 2; tries++) {
    try {
      await io.writeFile(lock, String(process.pid), { flag: 'wx' });
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = Number(await io.readFile(lock, 'utf8').catch(() => '')); // gone between the two reads: taken on the next try
      if (alive(other)) throw new Error(`Another Postbox store (process ${other}) holds ${dir}. Stop it first, or use another data folder.`);
      await io.rm(lock, { force: true });
    }
  }
  throw new Error(`Couldn’t claim ${dir}: ${lock} keeps coming back.`);
}

/** @param {typeof import('node:fs/promises')} io @param {string|null} lock */
export async function unlockStore(io, lock) {
  if (lock) await io.rm(lock, { force: true });
}
