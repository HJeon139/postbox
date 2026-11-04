// The commit privacy scan (tools/scan-commits-privacy.mjs, #508) against real git: each case makes a throwaway
// repository, commits to it, and runs the tool over a range there, as CI runs it over a pull request’s commits. It starts
// git and node, which tests/guard.mjs keeps out of the unit tests, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../../tools/scan-commits-privacy.mjs', import.meta.url));

// A made-up home path, built here so this file doesn’t hold one for the tree’s own privacy check to flag.
const HOME = ['', 'Users', 'alice'].join('/');
const HOME_PATH = `${HOME}/x`;

const home = await mkdtemp(join(tmpdir(), 'pb-test-scan-commits-'));
after(() => rm(home, { recursive: true, force: true }));
// Git as a fresh install would be, whoever runs this: no hooks, signing or templates from the person’s own config.
await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };

/** Runs git in a repository, and fails the test if git does. */
function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** The tool over a range in a repository: its exit code and what it printed. */
function scan(cwd, range) {
  const run = spawnSync(process.execPath, [TOOL, range], { cwd, env, encoding: 'utf8', timeout: 20_000 });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

/** A fresh repository with one commit on main, and a branch “work” from it. */
async function repo() {
  const dir = await mkdtemp(join(home, 'repo-'));
  git(dir, 'init', '-q', '.');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'switch', '-q', '-c', 'work');
  return dir;
}

/** Writes a file and commits it. */
async function commit(dir, path, content) {
  await writeFile(join(dir, path), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `change ${path}`);
  return git(dir, 'rev-parse', '--short=7', 'HEAD');
}

test('a commit that adds a home path fails, naming its commit and file', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'notes.md', `see ${HOME_PATH}\n`);
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} notes\\.md: home path: ${HOME}$`, 'm'));
});

test('a home path added in one commit and removed in a later one still fails', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'notes.md', `see ${HOME_PATH}\n`);
  await commit(dir, 'notes.md', 'see nothing\n');
  assert.equal(git(dir, 'show', 'HEAD:notes.md'), 'see nothing');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} notes\\.md: `, 'm'));
});

test('a range whose commits add nothing private passes, and says how much it read', async () => {
  const dir = await repo();
  await commit(dir, 'notes.md', 'one\ntwo\n');
  await commit(dir, 'more.md', 'three\n');
  const { status, out } = scan(dir, 'main..HEAD');
  assert.equal(status, 0);
  assert.match(out, /2 commits added 3 lines in 2 files, none of them private/);
});

test('a binary file holding a home path passes, and is counted as skipped', async () => {
  const dir = await repo();
  await commit(dir, 'image.bin', `\0${HOME_PATH}\n`);
  const { status, out } = scan(dir, 'main..HEAD');
  assert.equal(status, 0);
  assert.match(out, /1 binary file skipped/);
});

test('a rename that changes no lines passes', async () => {
  const dir = await repo();
  git(dir, 'mv', 'a.txt', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'rename');
  const { status, out } = scan(dir, 'main..HEAD');
  assert.equal(status, 0);
  assert.match(out, /1 commit added 0 lines in 0 files/);
});

test('an empty range passes, and says it had no commits', async () => {
  const dir = await repo();
  const { status, out } = scan(dir, 'main..HEAD');
  assert.equal(status, 0);
  assert.match(out, /no commits in main\.\.HEAD/);
});

test('a range git can’t read fails with a message that names it', async () => {
  const dir = await repo();
  const { status, err } = scan(dir, 'nowhere..HEAD');
  assert.equal(status, 2);
  assert.match(err, /can’t list the commits in nowhere\.\.HEAD/);
});
