// What’s at a worktree’s folder, read from git’s own files: whether git finished making it, and how one Postbox made
// is removed (#1709). Moved from agent-worktree.mjs, which makes each agent’s worktree with these.

import { access, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { gitPointer } from './agy-git-dir.mjs';

/**
 * Whether git’s record of the worktree at dir holds git’s own marker for one it’s still making (stateOf), read from
 * `worktree list`, which names each by its real path.
 * @param {import('./agent-worktree.mjs').Git} git @param {string} repo @param {string} dir
 */
export async function gitsOwnLock(git, repo, dir) {
  const real = await realpath(dirname(dir)).then(
    (parent) => join(parent, basename(dir)),
    () => dir,
  );
  const listed = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout ?? '';
  return listed.split('\n\n').some((entry) => {
    const lines = entry.split('\n');
    return (lines[0] === `worktree ${real}` || lines[0] === `worktree ${dir}`) && lines.includes('locked initializing');
  });
}

/** Whether a path is there. @param {string} path */
export const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A worktree folder’s state: unfinished while git’s marker for one it’s still making is there, a `locked` file in its
 * admin folder that says `initializing` (git writes it so, under the C locale runGit sets); finished, with its .git
 * naming that admin folder, whose HEAD is there, and no such marker; else none. A `locked` file saying anything else is a lock someone set
 * (`git worktree lock`, empty or with its reason) on a worktree that may hold their work: it’s finished, and used. A
 * lock someone set with the reason `initializing` reads as git’s own marker.
 * @param {string} dir @returns {Promise<'finished' | 'unfinished' | 'none'>}
 */
export async function stateOf(dir) {
  try {
    const admin = gitPointer(await readFile(join(dir, '.git'), 'utf8'), 'gitdir: ');
    if (!admin) return 'none';
    // Git’s own marker first: an add stopped before it wrote the record’s HEAD is still one to remove and make again.
    const lock = await readFile(join(resolve(dir, admin), 'locked'), 'utf8').catch(() => null);
    if (lock?.trim() === 'initializing') return 'unfinished';
    // Git’s record of it gone (the repository cloned again, or its .git deleted): no worktree git can use.
    return (await exists(join(resolve(dir, admin), 'HEAD'))) ? 'finished' : 'none';
  } catch {
    return 'none';
  }
}

/**
 * Removes a worktree Postbox made, through git and then from disk. Git removes a worktree it locked while making it
 * only when told to force twice.
 * @param {import('./agent-worktree.mjs').Git} git @param {string} repo @param {string} dir
 */
export async function removeWorktree(git, repo, dir) {
  await git(repo, ['worktree', 'remove', '--force', '--force', dir]);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
