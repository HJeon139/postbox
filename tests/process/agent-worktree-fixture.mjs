// The shared setup of the real-git worktree tests (tests/process/agent-worktree*.test.mjs, #1709): a temp home with git
// as a fresh install would be, and a project that is a repository with one commit.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export const home = await mkdtemp(join(tmpdir(), 'pb-test-worktree-'));
after(() => rm(home, { recursive: true, force: true }));
// Git as a fresh install would be, whoever runs this: no hooks, signing or templates from the person’s own config.
await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
export const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

/** A project folder that is a repository with one commit, and the data folder Postbox keeps worktrees in. @param {string} name */
export async function project(name) {
  const folder = join(home, name, 'project');
  await mkdir(folder, { recursive: true });
  git(folder, ['init', '-q']);
  await writeFile(join(folder, 'README.md'), 'hello\n');
  git(folder, ['add', 'README.md']);
  git(folder, ['commit', '-q', '-m', 'first']);
  return { project: { id: `pr_${name}`, folder }, workRoot: join(home, name, 'data', 'work') };
}
