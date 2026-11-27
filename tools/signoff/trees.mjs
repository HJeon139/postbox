// Steps 2 and 3 of tools/signoff.mjs (#845). Both check out code in a temporary worktree of their own, detached, so
// the person’s working tree, index and branches never change; git keeps only the worktree’s note in its own folder
// until the step removes it.
// - Step 2: Biome at each commit from the merge base to HEAD, on the files that commit changes, with the biome.json
//   of that commit. A commit that fails is red even when a later one fixes it: each commit is reviewed and reverted
//   alone (designs/engineering-practices.md, “Commits and versions”).
// - Step 3: the tree a merge would make with the base freshly fetched from the pull request’s base repository.
//   main’s ruleset doesn’t require a head to be current with main, so a head green on its own can still conflict, or
//   fail a lint, once merged. A conflict fails; a clean merge is checked out and runs Biome and the project lints, as
//   `npm run lint` and `npm run lint:project` do.

import { join } from 'node:path';
import { untilStopped } from './stop.mjs';
import { exec, firstLine, lastLine, must } from './wait.mjs';

/** Biome as npm run lint runs it, from this checkout’s node_modules: a temporary worktree has none. @param {string} root */
const biome = (root) => [join(root, 'node_modules/.bin/biome'), 'check', '--error-on-warnings'];

/** The identity of the merge commit step 3 writes: an object only, which no branch points at. */
const MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: 'signoff',
  GIT_AUTHOR_EMAIL: 'signoff@localhost',
  GIT_COMMITTER_NAME: 'signoff',
  GIT_COMMITTER_EMAIL: 'signoff@localhost',
};

/**
 * Runs fn in a temporary detached worktree at sha, and removes the worktree however fn ends, a signal included
 * (./stop.mjs): fn runs its commands with the Stop it’s given. Only this worktree is removed, by its folder; the
 * person’s others are never pruned.
 * @template T
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string} sha
 * @param {(dir: string, stop: import('./stop.mjs').Stop) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function inWorktree(d, root, sha, fn) {
  return untilStopped(d, 'a temporary worktree’s checks', async (stop) => {
    const dir = d.mkdtemp(join(d.tmpdir(), 'pb-signoff-'));
    try {
      await must(d, ['git', 'worktree', 'add', '--quiet', '--detach', dir, sha], { cwd: root, stop });
      // The project lints run Biome from the checkout’s node_modules (tools/lint-ternary.mjs), which git doesn’t hold.
      d.link(join(root, 'node_modules'), join(dir, 'node_modules'));
      return await fn(dir, stop);
    } finally {
      await exec(d, ['git', 'worktree', 'remove', '--force', dir], { cwd: root });
      d.rm(dir);
    }
  });
}

/**
 * The URL of the repository a pull request merges into, from the pull request’s own URL on GitHub: a fork’s origin is
 * the fork, so a remote of the clone may not be it.
 * @param {number} pr @param {string} prUrl
 */
export function baseRepo(pr, prUrl) {
  const repo = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/pull\/\d+$/.exec(String(prUrl))?.[1];
  if (!repo) throw new Error(`#${pr}’s URL, ${prUrl}, names no repository`);
  return repo;
}

/**
 * Fetches base from the pull request’s base repository and returns its commit and the merge base with HEAD. The commit
 * is FETCH_HEAD, read as soon as the fetch ends: a remote-tracking ref goes stale without a word in a single-branch
 * clone or one with a narrowed refspec, and steps 2 and 3 must not use an old base.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {{ pr: number, prUrl: string, base: string }} o
 */
export async function fetchBase(d, root, { pr, prUrl, base }) {
  const repo = baseRepo(pr, prUrl);
  await must(d, ['git', 'fetch', '--quiet', '--no-tags', '--', repo, `refs/heads/${base}`], { cwd: root });
  const baseSha = await must(d, ['git', 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { cwd: root });
  const mergeBase = await must(d, ['git', 'merge-base', 'HEAD', baseSha], { cwd: root });
  return { baseSha, mergeBase };
}

/**
 * The files commit sha changes and keeps, each name as it is: -z leaves it unquoted and unsplit, and no trim cuts its
 * spaces. Biome gets them after --, so a name that starts with - isn’t read as an option.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string} sha @param {import('./stop.mjs').Stop} stop
 */
async function changedFiles(d, root, sha, stop) {
  const argv = ['git', 'diff', '-z', '--name-only', '--diff-filter=d', `${sha}^1`, sha, '--'];
  const r = await exec(d, argv, { cwd: root, stop });
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${firstLine(r.out)}`);
  return r.out.split('\0').filter(Boolean);
}

/**
 * Step 2: Biome on each commit’s changed files, at that commit.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string} mergeBase
 */
export async function eachCommit(d, root, mergeBase) {
  const shas = (await must(d, ['git', 'rev-list', '--reverse', `${mergeBase}..HEAD`], { cwd: root })).split('\n').filter(Boolean);
  // A pull request with no commits of its own checked nothing: that’s a wrong base, not a pass.
  if (!shas.length) return { ok: false, why: `no commits between the merge base ${mergeBase.slice(0, 8)} and HEAD` };
  /** @type {string[]} */
  const red = [];
  await inWorktree(d, root, shas[0], async (dir, stop) => {
    for (const sha of shas) {
      const files = await changedFiles(d, root, sha, stop);
      if (!files.length) continue;
      await must(d, ['git', 'checkout', '--quiet', '--detach', sha], { cwd: dir, stop });
      const r = await exec(d, [...biome(root), '--no-errors-on-unmatched', '--files-ignore-unknown=true', '--', ...files], { cwd: dir, stop });
      if (r.code !== 0) red.push(`${sha.slice(0, 8)} (${firstLine(r.out)})`);
    }
  });
  if (red.length) return { ok: false, why: `Biome fails at ${red.length} of ${shas.length} commits: ${red.join('; ')}` };
  return { ok: true, note: `Biome passes at each of ${shas.length} commits` };
}

/**
 * The tree a merge of HEAD and baseSha makes, or the conflicts that stop it.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string} baseSha
 */
async function mergeTree(d, root, baseSha) {
  const r = await exec(d, ['git', 'merge-tree', '--write-tree', '--name-only', 'HEAD', baseSha], { cwd: root });
  // git merge-tree exits 1 for a conflict and above that when it couldn’t merge at all.
  if (r.code === 1) {
    const files = r.out.split('\n\n')[0].split('\n').slice(1).filter(Boolean);
    return { conflict: `conflicts with ${baseSha.slice(0, 8)} in ${files.join(', ') || 'files git didn’t name'}` };
  }
  if (r.code !== 0) return { conflict: `git merge-tree exited ${r.code}: ${firstLine(r.out)}` };
  return { tree: firstLine(r.out) };
}

/**
 * Step 3: HEAD merges cleanly with the fetched base, and the merged tree passes Biome and the project lints.
 * @param {import('./deps.mjs').Deps} d @param {string} root @param {string} base @param {string} baseSha
 */
export async function mergedTree(d, root, base, baseSha) {
  const { tree, conflict } = await mergeTree(d, root, baseSha);
  if (!tree) return { ok: false, why: conflict };
  const commitTree = ['git', 'commit-tree', tree, '-p', 'HEAD', '-p', baseSha, '-m', 'signoff: the merged tree'];
  const merged = await must(d, commitTree, { cwd: root, env: MERGE_IDENTITY });
  /** @type {string[]} */
  const failed = [];
  await inWorktree(d, root, merged, async (dir, stop) => {
    const lint = await exec(d, [...biome(root), '.'], { cwd: dir, stop });
    if (lint.code !== 0) failed.push(`Biome (${firstLine(lint.out)})`);
    // BASE_SHA points the lints that compare with a base (tools/merge-base.mjs) at the base just fetched, not at
    // origin/<base>, which can be stale or missing; BASE_REF names it.
    const project = await exec(d, ['npm', 'run', '-s', 'lint:project'], { cwd: dir, env: { BASE_REF: base, BASE_SHA: baseSha }, stop });
    // Each lint prints a line; the one that failed is the last, as .githooks/pre-commit reads it.
    if (project.code !== 0) failed.push(`the project lints (${lastLine(project.out)})`);
  });
  if (failed.length) return { ok: false, why: `the tree merged with ${base} fails ${failed.join(' and ')}` };
  return { ok: true, note: `merges cleanly with ${base} at ${baseSha.slice(0, 8)}; Biome and the project lints pass on the merge` };
}
