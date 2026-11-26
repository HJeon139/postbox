// #1709, from critic’s review of #1719: an Antigravity agent in its own git worktree runs routine git (status, diff,
// log) with no card in Auto, as in a checkout. A worktree’s .git is a file naming the main repository’s
// `.git/worktrees/<name>`, outside the agent’s folders, so the agent can’t have written the config git reads there.
// A .git file pointing anywhere else still asks (server/adapters/agy-git-dir.mjs).

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitPointer, ownGitDir } from '../server/adapters/agy-git-dir.mjs';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A main repository and an agent’s worktree of it, as `git worktree add` lays them out. */
function layout() {
  const root = tempDir('pb-agy-git-');
  const repo = join(root, 'repo');
  const admin = join(repo, '.git', 'worktrees', 'agent');
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, 'commondir'), '../..\n');
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
  // At a real worktree folder whose commondir names a repository the agent may edit.
  const theirs = join(wt, 'own-repo', '.git');
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(repo, '.git', 'worktrees', 'agent', 'commondir'), `${theirs}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'agent')}\n`);
  assert.equal(git(wt), 'ask');
  // No gitdir line at all.
  writeFileSync(join(wt, '.git'), 'not a pointer\n');
  assert.equal(git(wt), 'ask');
});

// From critic’s review of #1719 at 3c844d77: each guard, alone, is what makes these ask.
test('#1709 a worktree folder inside the agent’s own folders asks, even naming a real repository', () => {
  const { repo, wt, git } = layout();
  const own = join(wt, 'fake', 'worktrees', 'x');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'commondir'), `${join(repo, '.git')}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${own}\n`);
  assert.equal(git(wt), 'ask');
});

test('#1709 a folder not under a `worktrees` folder asks, even with a commondir', () => {
  const { root, repo, wt, git } = layout();
  const other = join(root, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'commondir'), `${join(repo, '.git')}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${other}\n`);
  assert.equal(git(wt), 'ask');
});

test('#1709 an empty commondir asks', () => {
  const { admin, wt, git } = layout();
  writeFileSync(join(admin, 'commondir'), '\n');
  assert.equal(git(wt), 'ask');
});

test('#1709 a .git that is a link asks, even to a good pointer', () => {
  const { root, admin, wt, git } = layout();
  const pointer = join(root, 'pointer');
  writeFileSync(pointer, `gitdir: ${admin}\n`);
  rmSync(join(wt, '.git'));
  symlinkSync(pointer, join(wt, '.git'));
  assert.equal(git(wt), 'ask');
});

test('#1709 folders are compared as real paths: a root given through a link, or a gitdir through one, still counts', () => {
  const { root, repo, admin, wt, git } = layout();
  // The worktree folder and the repository its commondir names are in different places, so each check stands alone.
  const repo2 = join(root, 'repo2', '.git');
  mkdirSync(repo2, { recursive: true });
  writeFileSync(join(admin, 'commondir'), `${repo2}\n`);
  assert.equal(git(wt), 'allow');
  // The agent may edit the repository commondir names, given through a link.
  const repo2Link = join(root, 'repo2-link');
  symlinkSync(join(root, 'repo2'), repo2Link);
  assert.equal(git(wt, [wt, repo2Link]), 'ask');
  // decideAgyTool gives ownGitDir real paths already (agy-hook.mjs); ownGitDir holds its own rule for any other caller.
  assert.equal(ownGitDir(wt, [wt, repo2Link]), false);
  // The agent may edit the folder holding the worktree folder, given through a link.
  const repoLink = join(root, 'repo-link');
  symlinkSync(repo, repoLink);
  assert.equal(git(wt, [wt, repoLink]), 'ask');
  assert.equal(ownGitDir(wt, [wt, repoLink]), false);
  assert.equal(ownGitDir(wt, [wt]), true);
  writeFileSync(join(admin, 'commondir'), '../..\n');
  // A gitdir named through a link outside the agent’s folders, whose real folder is inside them.
  const own = join(wt, 'fake', 'worktrees', 'x');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'commondir'), `${join(repo, '.git')}\n`);
  const alias = join(root, 'alias');
  symlinkSync(join(wt, 'fake'), alias);
  writeFileSync(join(wt, '.git'), `gitdir: ${join(alias, 'worktrees', 'x')}\n`);
  assert.equal(git(wt), 'ask');
  // The good pointer still allows.
  writeFileSync(join(wt, '.git'), `gitdir: ${admin}\n`);
  assert.equal(git(wt), 'allow');
});

test('#1709 a .git file and a commondir are read as git reads them', () => {
  assert.equal(gitPointer('gitdir: /r/.git/worktrees/a\n', 'gitdir: '), '/r/.git/worktrees/a');
  assert.equal(gitPointer('gitdir: /r/.git/worktrees/a\r\n', 'gitdir: '), '/r/.git/worktrees/a');
  assert.equal(gitPointer('# note\ngitdir: /r/.git/worktrees/a\n', 'gitdir: '), null, 'gitdir: must start the file');
  assert.equal(gitPointer('gitdir:/r\n', 'gitdir: '), null);
  assert.equal(gitPointer(' ../..\n'), ' ../..', 'only trailing newlines go');
  assert.equal(gitPointer('\n'), null);
});
