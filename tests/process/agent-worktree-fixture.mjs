// The shared setup of the real-git worktree tests (tests/process/agent-worktree*.test.mjs, agent-submodules*.test.mjs,
// #1709, #1856): a temp home with git as a fresh install would be, a project that is a repository with one commit,
// and one whose repository has a submodule.

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

/**
 * A project whose repository has one submodule, at `path`, checked out in the person’s folder (#1856). The repository
 * it was cloned from is then deleted, so anything that fetched it would fail. `persons` reads what the person’s own
 * checkouts hold: both HEADs, both branches and both statuses.
 * @param {string} name @param {string} [path]
 */
export async function withSubmodule(name, path = 'lib') {
  const { project: lib } = await project(`${name}-lib`);
  const { project: p, workRoot } = await project(name);
  git(p.folder, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.folder, path]);
  git(p.folder, ['commit', '-q', '-m', 'a submodule']);
  await rm(lib.folder, { recursive: true, force: true });
  /** @type {string[]} */
  const logs = [];
  const o = { log: (/** @type {string} */ l) => logs.push(l) };
  const persons = () =>
    [p.folder, join(p.folder, path)].map((d) => [
      git(d, ['rev-parse', 'HEAD']),
      git(d, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(d, ['status', '--porcelain']),
    ]);
  return { p, workRoot, logs, o, persons };
}
