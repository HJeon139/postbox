// The submodules in an Antigravity agent’s worktree (#1856). `git worktree add` leaves each submodule’s folder empty,
// and a project with submodules used to keep its agents in the project’s own folder, taking turns. Each submodule the
// person’s checkout holds is now there in the agent’s worktree too, as a worktree of the person’s own submodule
// repository, on a branch named as the agent’s is in the project:
//
//   <the agent’s worktree>/<submodule path>/     a worktree of <the project’s folder>/<submodule path>
//
// Nothing is cloned or fetched, so nothing reaches the network or needs `protocol.file.allow`, and git’s submodule
// commands, which run the repository’s own ssh command, never run. The person’s submodule checkout is only read: its
// repository gains a branch and git’s record of the worktree, as the project’s repository does. A submodule the
// person’s checkout doesn’t hold (never initialized, or without the commit the project names) stays empty, as it is
// in the project’s folder, and the server log says why. Submodules inside a submodule stay empty too. What an agent
// changes in one is committed at the turn’s end (agent-worktree-commit.mjs).

import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { gitsReason, removeWorktree, stateOf } from './worktree-state.mjs';

/** @typedef {import('./agent-worktree.mjs').Git} Git */

/** At most this many submodules are made per worktree; a project with more keeps the rest empty. */
const MOST = 100;

/**
 * Which of these paths the folder’s current commit holds as a repository of its own (a gitlink), with the commit each
 * names. Asked of the person’s repository, never of an agent’s worktree.
 * @param {Git} git @param {string} top  the repository’s top folder @param {string[]} paths
 * @returns {Promise<{ path: string, sha: string }[]>}
 */
export async function gitlinksAt(git, top, paths) {
  if (paths.length === 0) return [];
  const tree = await git(top, ['ls-tree', '-z', 'HEAD', '--', ...paths]);
  if (tree.code !== 0) return [];
  return tree.stdout.split('\0').flatMap((entry) => {
    const m = /^160000 commit ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    return m ? [{ path: m[2], sha: m[1] }] : [];
  });
}

/**
 * The submodules the project’s current commit names in its .gitmodules, each with its commit. Read from the commit,
 * not the folder, so it’s what the person committed.
 * @param {Git} git @param {string} top  the project’s repository’s top folder
 */
async function submodulesOf(git, top) {
  const named = await git(top, ['config', '--blob', 'HEAD:.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$']);
  if (named.code !== 0) return [];
  // Each entry is the key, a newline, then the path.
  const paths = named.stdout.split('\0').flatMap((entry) => (entry.includes('\n') ? [entry.slice(entry.indexOf('\n') + 1)] : []));
  return gitlinksAt(git, top, paths.filter(Boolean).slice(0, MOST));
}

/**
 * Makes one submodule’s worktree, and returns why not when it stays empty, else null.
 * @param {Git} git @param {{ theirs: string, mine: string, root: string, branch: string, sha: string }} o  theirs: the
 *   person’s checkout of it; mine: its folder in the agent’s worktree, whose real path is root
 */
async function addOne(git, { theirs, mine, root, branch, sha }) {
  // A link at the submodule’s own folder would have git check it out wherever the link points.
  if ((await lstat(mine).catch(() => null))?.isSymbolicLink()) return 'its folder in the worktree leads outside it';
  const state = await stateOf(mine);
  if (state === 'finished') return null;
  // The agent can write its worktree: a link on the way to the submodule’s folder would have git work outside it.
  const parent = await realpath(dirname(mine)).catch(() => null);
  if (!parent || !(parent === root || parent.startsWith(`${root}${sep}`))) return 'its folder in the worktree leads outside it';
  // An empty or missing folder isn’t a repository of its own: git would answer there with the project’s.
  const top = await git(theirs, ['rev-parse', '--show-toplevel']);
  const real = top.code === 0 ? await realpath(top.stdout.trim()).catch(() => null) : null;
  if (!real || real !== (await realpath(theirs).catch(() => null))) return 'it isn’t checked out in the project’s folder';
  if (state === 'unfinished') await removeWorktree(git, theirs, mine);
  const has = (await git(theirs, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  const add = ['-c', 'submodule.recurse=false', 'worktree', 'add'];
  const added = await git(theirs, has ? [...add, mine, branch] : [...add, '-b', branch, mine, sha]);
  if (added.code === 0) return null;
  // Only what this add made goes, as for the agent’s own worktree; git keeps a submodule’s folder, empty.
  if ((await stateOf(mine)) !== 'none') await removeWorktree(git, theirs, mine);
  await mkdir(mine, { recursive: true }).catch(() => {});
  return gitsReason(added);
}

/**
 * Makes the worktree of each submodule the project’s current commit names that isn’t in the agent’s worktree yet.
 * Returns the ones left empty, each with why.
 * @param {Git} git @param {{ repo: string, dir: string, branch: string }} o  repo: the project’s repository’s top
 *   folder; dir: the agent’s worktree; branch: the agent’s branch, made in each submodule’s repository too
 * @returns {Promise<{ path: string, why: string }[]>}
 */
export async function addSubmodules(git, { repo, dir, branch }) {
  const root = await realpath(dir).catch(() => null);
  if (!root) return [];
  const left = [];
  for (const { path, sha } of await submodulesOf(git, repo)) {
    const why = await addOne(git, { theirs: join(repo, path), mine: join(dir, path), root, branch, sha });
    if (why) left.push({ path, why });
  }
  return left;
}
