// The commit privacy scan (tools/scan-commits-privacy.mjs, #508) against real git: each case makes a throwaway
// repository, commits to it, and runs the tool over a range there, as CI runs it over a pull request’s commits. It starts
// git and node, which tests/guard.mjs keeps out of the unit tests, so it’s under tests/process/ (npm run test:process).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../../tools/scan-commits-privacy.mjs', import.meta.url));

// A made-up home path, built here so this file doesn’t hold one for the tree’s own privacy check to flag.
const HOME = ['', 'Users', 'alice'].join('/');
const HOME_PATH = `${HOME}/x`;
// The home as the checker reports it: from the folder name on, without the slash before it.
const REPORTED_HOME = HOME.slice(1);

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

/**
 * The tool over a range in a repository: its exit code and what it printed. Each of config is set as `git -c` sets it,
 * for every git the tool starts, as a person’s own config would be.
 */
function scan(cwd, range, config = {}) {
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
async function repo() {
  const dir = await mkdtemp(join(home, 'repo-'));
  git(dir, 'init', '-q', '.');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'switch', '-q', '-c', 'work');
  return dir;
}

/** Writes a file and commits it, with a message of its own or one that names the file. */
async function commit(dir, path, content, message = `change ${path}`) {
  await writeFile(join(dir, path), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', '--short=7', 'HEAD');
}

/** Lines one to eight of a file, with the given lines replaced. */
const eightLines = (changed = {}) => `${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((line, i) => changed[i] ?? line).join('\n')}\n`;

test('a commit that adds a home path fails, naming its commit and file', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'notes.md', `see ${HOME_PATH}\n`);
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} notes\\.md: home path: ${REPORTED_HOME}$`, 'm'));
});

test('the tool run through a symlink to the checkout’s folder still scans, and fails on a home path', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'notes.md', `see ${HOME_PATH}\n`);
  // node runs the tool under its real path, while process.argv[1] keeps the symlink’s.
  const linked = join(home, 'linked-checkout');
  await symlink(dirname(dirname(TOOL)), linked);
  const run = spawnSync(process.execPath, [join(linked, 'tools', 'scan-commits-privacy.mjs'), 'main..HEAD'], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, new RegExp(`^${sha} notes\\.md: home path: ${REPORTED_HOME}$`, 'm'));
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

test('a merge whose conflict resolution adds a home path fails, naming the merge', async () => {
  const dir = await repo();
  await commit(dir, 'c.txt', 'base\n');
  git(dir, 'switch', '-q', '-c', 'side');
  await commit(dir, 'c.txt', 'side\n');
  git(dir, 'switch', '-q', 'work');
  await commit(dir, 'c.txt', 'work\n');
  assert.equal(spawnSync('git', ['merge', '-q', 'side'], { cwd: dir, env }).status, 1, 'the merge conflicts');
  const sha = await commit(dir, 'c.txt', `${HOME_PATH}\n`, 'merge side');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} c\\.txt: home path: ${REPORTED_HOME}$`, 'm'));
});

test('a merge with no conflict that adds a file of its own fails, naming the merge', async () => {
  const dir = await repo();
  git(dir, 'switch', '-q', '-c', 'side');
  await commit(dir, 's.txt', 'side\n');
  git(dir, 'switch', '-q', 'work');
  await commit(dir, 'w.txt', 'work\n');
  git(dir, 'merge', '-q', '--no-commit', 'side');
  const sha = await commit(dir, 'evil.txt', `${HOME_PATH}\n`, 'merge side');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} evil\\.txt: home path: ${REPORTED_HOME}$`, 'm'));
});

test('a merge that adds nothing of its own passes, and is counted, as the merge CI checks out is', async () => {
  const dir = await repo();
  await commit(dir, 'w.txt', 'work\n');
  git(dir, 'switch', '-q', 'main');
  await commit(dir, 'm.txt', 'main\n');
  git(dir, 'switch', '-q', '--detach', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge work into main', 'work');
  const { status, out } = scan(dir, 'main..HEAD');
  assert.equal(status, 0);
  assert.match(out, /2 commits added 1 line in 1 file, none of them private/);
});

test('a commit message whose trailer holds a home path fails, naming the commit’s message', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'notes.md', 'one\n', `change notes\n\nSeen-at: ${HOME_PATH}`);
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} message: home path: ${REPORTED_HOME}$`, 'm'));
});

test('a commit message with the Co-Authored-By trailer this repository asks for passes', async () => {
  const dir = await repo();
  await commit(dir, 'notes.md', 'one\n', 'change notes\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.equal(scan(dir, 'main..HEAD').status, 0);
});

test('a text file that .gitattributes marks “-diff” is still checked', async () => {
  const dir = await repo();
  await writeFile(join(dir, '.gitattributes'), '*.md -diff\n');
  const sha = await commit(dir, 'notes.md', `see ${HOME_PATH}\n`);
  await commit(dir, 'notes.md', 'see nothing\n');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} notes\\.md: home path: ${REPORTED_HOME}$`, 'm'));
});

test('a file outside the folder the tool runs in is checked, whatever diff.relative says', async () => {
  const dir = await repo();
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'ok.md'), 'fine\n');
  const sha = await commit(dir, 'top.md', `see ${HOME_PATH}\n`);
  const { status, err } = scan(join(dir, 'sub'), 'main..HEAD', { 'diff.relative': 'true' });
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} top\\.md: home path: ${REPORTED_HOME}$`, 'm'));
});

test('two changes a few lines apart are read as two hunks, whatever diff.interHunkContext says', async () => {
  const dir = await repo();
  await commit(dir, 'a.txt', eightLines());
  git(dir, 'switch', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'work');
  git(dir, 'switch', '-q', 'work');
  const sha = await commit(dir, 'a.txt', eightLines({ 1: HOME_PATH, 6: 'X' }));
  const { status, err } = scan(dir, 'main..HEAD', { 'diff.interHunkContext': '5' });
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} a\\.txt: home path: ${REPORTED_HOME}$`, 'm'));
});

test('the findings are reported oldest commit first', async () => {
  const dir = await repo();
  const first = await commit(dir, 'one.md', `${HOME_PATH}\n`);
  const second = await commit(dir, 'two.md', `${HOME_PATH}\n`);
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  const shas = err
    .split('\n')
    .filter((line) => line.includes(': home path'))
    .map((line) => line.split(' ')[0]);
  assert.deepEqual(shas, [first, second]);
});

test('colors, prefixes and an external diff in a person’s own config don’t change what is read', async () => {
  const dir = await repo();
  const sha = await commit(dir, 'notes.md', `see ${HOME_PATH}\n`);
  const config = { 'color.ui': 'always', 'diff.noprefix': 'true', 'diff.external': 'false' };
  const { status, err } = scan(dir, 'main..HEAD', config);
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} notes\\.md: home path: ${REPORTED_HOME}$`, 'm'));
});

test('a range that starts with “-” is read as a range, not as one of git’s options', async () => {
  const dir = await repo();
  await commit(dir, 'notes.md', 'one\n');
  const { status, err } = scan(dir, '--all');
  assert.equal(status, 2);
  assert.match(err, /can’t list the commits in --all/);
});
