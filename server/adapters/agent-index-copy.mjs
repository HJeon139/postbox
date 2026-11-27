// Postbox’s copy of an agent worktree’s index, which the commit at the end of an Antigravity turn is built from
// (agent-worktree-commit.mjs, #1844).

import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';

/**
 * Copies a worktree’s index to Postbox’s own file. Only a regular file is copied, opened without following a link and
 * without waiting, so an index replaced by anything else (a link, a pipe) leaves the turn uncommitted rather than
 * holding it (#1844). No index at all is read as an empty one, by the worktree and by the copy alike.
 * @param {string} from @param {string} to @returns {Promise<boolean>}
 */
export async function copyIndex(from, to) {
  const fh = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((/** @type {any} */ e) => e);
  if (!fh || typeof fh.close !== 'function') return fh?.code === 'ENOENT';
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
