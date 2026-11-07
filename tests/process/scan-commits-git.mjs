// The real git the commit privacy scan’s process specs run it against (tests/process/scan-commits-privacy.test.mjs and
// tests/process/scan-commits-privacy-names.test.mjs): a temp home with a fresh git config of its own, removed after the
// run, and the helpers that make a throwaway repository, commit to it and run the tool over a range there.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const TOOL = fileURLToPath(new URL('../../tools/scan-commits-privacy.mjs', import.meta.url));

// A made-up home path, built here so this file doesn’t hold one for the tree’s own privacy check to flag.
export const HOME = ['', 'Users', 'alice'].join('/');
export const HOME_PATH = `${HOME}/x`;

export const home = await mkdtemp(join(tmpdir(), 'pb-test-scan-commits-'));
after(() => rm(home, { recursive: true, force: true }));
// Git as a fresh install would be, whoever runs this: no hooks, signing or templates from the person’s own config.
await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
export const env = { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };

/** Runs git in a repository, and fails the test if git does. */
export function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * The tool over a range in a repository: its exit code and what it printed. Each of config is set as `git -c` sets it,
 * for every git the tool starts, as a person’s own config would be.
 */
export function scan(cwd, range, config = {}) {
  const pairs = Object.entries(config);
  const settings = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    settings[`GIT_CONFIG_KEY_${i}`] = key;
    settings[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  const run = spawnSync(process.execPath, [TOOL, range], { cwd, env: { ...env, ...settings }, encoding: 'utf8', timeout: 20_000 });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

/** A fresh repository with one commit on main, and a branch “work” from it. */
export async function repo() {
  const dir = await mkdtemp(join(home, 'repo-'));
  git(dir, 'init', '-q', '.');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'switch', '-q', '-c', 'work');
  return dir;
}

/** Writes a file and commits it, with a message of its own or one that names the file. */
export async function commit(dir, path, content, message = `change ${path}`) {
  await writeFile(join(dir, path), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', '--short=7', 'HEAD');
}
