// #1709, from critic’s review of #1719: an Antigravity agent in its own git worktree runs routine git (status, diff,
// log) with no card in Auto, as in a checkout. A worktree’s .git is a file naming the main repository’s
// `.git/worktrees/<name>`, outside the agent’s folders, so the agent can’t have written the config git reads there.
// A .git file pointing anywhere else still asks (server/adapters/agy-git-dir.mjs).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A main repository and an agent’s worktree of it, as `git worktree add` lays them out. */
function layout() {
  const root = tempDir('pb-agy-git-');
  const repo = join(root, 'repo');
  const admin = join(repo, '.git', 'worktrees', 'agent');
  mkdirSync(admin, { recursive: true });
  const wt = join(root, 'worktrees', 'pr_x', 'pe_a');
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${admin}\n`);
  mkdirSync(join(root, 'home'));
  const git = (/** @type {string} */ cwd, folders = [cwd]) =>
    decideAgyTool({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } }, { mode: 'auto', folders, cwd, home: join(root, 'home') })
      .decision;
  return { root, repo, admin, wt, git };
}

test('#1709 in an agent’s worktree, routine git runs with no card, as in a checkout', () => {
  const { wt, git } = layout();
  assert.equal(git(wt), 'allow');
});

test('#1709 a .git file the agent could have written the target of still asks', () => {
  const { root, wt, repo, git } = layout();
  // Pointing into its own folder, where it can write a config.
  const own = join(wt, 'fake', 'worktrees', 'x');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${own}\n`);
  assert.equal(git(wt), 'ask');
  // At a folder that isn’t a repository’s worktree folder.
  const other = join(root, 'other');
  mkdirSync(other);
  writeFileSync(join(wt, '.git'), `gitdir: ${other}\n`);
  assert.equal(git(wt), 'ask');
  // At the main repository’s worktree folder, but the agent may also edit that repository.
  writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'agent')}\n`);
  assert.equal(git(wt, [wt, repo]), 'ask');
  // No gitdir line at all.
  writeFileSync(join(wt, '.git'), 'not a pointer\n');
  assert.equal(git(wt), 'ask');
});
