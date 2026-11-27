// Postbox’s copy of an agent worktree’s index, which the commit at the end of an Antigravity turn is built from
// (agent-worktree-commit.mjs, #1844), and git’s lock on that worktree’s index, held while it is.

import { constants } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {{ committed: boolean } | { why: string }} Outcome  whether it committed, or why it didn’t */

/**
 * Runs commit on Postbox’s copy of a worktree’s index, in dir, under git’s own lock on that index (index.lock in the
 * worktree’s record, made as git makes it: only when no one holds it, and never through a link). While it’s held, no
 * git the agent left running can write the index, so the index the copy came from is still the index when the
 * commit’s own is put in its place, through the lock as git does, with what git knew of each file it read. A lock
 * someone else holds (a git at work, or one that was killed) leaves the turn uncommitted, as it did when Postbox’s own
 * add met it. The lock is removed on every other outcome, so only a Postbox killed mid-commit leaves it, as a killed
 * git does (#1844).
 * @param {string} admin  the worktree’s record @param {string} dir  Postbox’s folder for the copy
 * @param {(index: string) => Promise<Outcome>} commit
 * @returns {Promise<Outcome>}
 */
export async function withIndexCopy(admin, dir, commit) {
  const lockPath = join(admin, 'index.lock');
  /** @type {import('node:fs/promises').FileHandle} */
  let lock;
  try {
    lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    return { why: code === 'EEXIST' ? 'another git is using its index' : `Postbox couldn’t lock its index (${code})` };
  }
  let written = false;
  try {
    const index = join(dir, 'index');
    if (!(await copyIndex(join(admin, 'index'), index))) return { why: 'its index isn’t a file Postbox can copy' };
    const done = await commit(index);
    if ('committed' in done && done.committed) {
      await lock.writeFile(await readFile(index));
      written = true;
    }
    return done;
  } finally {
    await lock.close();
    // Only a lock written whole takes the index’s place. Otherwise, or when that fails, the lock goes and the index
    // stays as it was, as git leaves it.
    if (!(written && (await install(lockPath, join(admin, 'index'))))) await rm(lockPath, { force: true });
  }
}

/** Puts the lock in the index’s place, as git does: false when it can’t. @param {string} lock @param {string} index */
const install = (lock, index) =>
  rename(lock, index).then(
    () => true,
    () => false,
  );

/**
 * Copies a worktree’s index to Postbox’s own file. Only a regular file is copied, opened without following a link and
 * without waiting, so an index replaced by anything else (a link, a pipe) leaves the turn uncommitted rather than
 * holding it (#1844). No index at all is read as an empty one, by the worktree and by the copy alike.
 * @param {string} from @param {string} to @returns {Promise<boolean>}
 */
export async function copyIndex(from, to) {
  /** @type {import('node:fs/promises').FileHandle} */
  let fh;
  try {
    fh = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT';
  }
  try {
    if (!(await fh.stat()).isFile()) return false;
    await writeFile(to, fh.createReadStream({ autoClose: false }));
    return true;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}
