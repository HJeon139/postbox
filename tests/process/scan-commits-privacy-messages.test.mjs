// What the commit privacy scan (tools/scan-commits-privacy.mjs) prints when git fails, and where it says a privately
// named file is, against real git: CI prints it to its public log, so it holds nothing git printed, which can name a
// path such as the repository’s, and names such a file by its place in the commit (#905). It runs git and node, so it’s
// under tests/process/, beside tests/process/scan-commits-privacy.test.mjs. A path holds no zero byte, so these feed
// git a quote, “<”, “&” and a home path.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commit, env, git, HOME_PATH, home, repo, scan, TOOL } from './scan-commits-git.mjs';

/** A path no message may repeat any part of: a quote, “<”, “&” and a home path. */
const HOSTILE = `"<&${HOME_PATH}`;

/** Asserts the scan’s output holds no run of three characters of the value. @param {string} output @param {string} value */
function holdsNone(output, value) {
  const leaked = [];
  for (let i = 0; i + 3 <= value.length; i++) if (output.includes(value.slice(i, i + 3))) leaked.push(value.slice(i, i + 3));
  assert.deepEqual(leaked, [], `“${output}” repeats part of “${value}”`);
}

/** What to do next, which every message about git’s failing ends with. */
const NEXT = 'Run the scan where you can see what git says.';

test('a repository git can’t open stops the scan without repeating what git said, which names its path (#905)', async () => {
  const dir = await repo();
  const gitDir = join(home, `gone${HOSTILE}`);
  const run = spawnSync(process.execPath, [TOOL, 'main..HEAD'], { cwd: dir, env: { ...env, GIT_DIR: gitDir }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.equal(run.stderr, `scan-commits-privacy: can’t find the repository: git ended with 128. ${NEXT}\n`);
  assert.ok(!run.stderr.includes(home), 'it holds the temp folder’s path');
  holdsNone(run.stderr, `gone${HOSTILE}`);
});

test('a range git can’t list stops the scan, naming the range and not what git said (#905)', async () => {
  const dir = await repo();
  const { status, err } = scan(dir, 'nowhere..HEAD');
  assert.equal(status, 2);
  assert.equal(err, `scan-commits-privacy: can’t list the commits in nowhere..HEAD: git ended with 128. Fetch the base first, or check the range.\n`);
});

test('a commit whose diff git can’t show stops the scan, naming the commit and not the command or its file (#905)', async () => {
  const dir = await repo();
  const name = `n${HOSTILE.replaceAll('/', '-')}.md`;
  const sha = await commit(dir, name, 'nothing private\n', 'add a note');
  const blob = git(dir, 'rev-parse', `HEAD:${name}`);
  await rm(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 2, err);
  assert.equal(err, `scan-commits-privacy: can’t read commit ${sha}’s diff: git ended with 128. ${NEXT}\n`);
  holdsNone(err, name);
});

test('a privately named file is counted in the commit as git show --name-only lists its files, deletions too (#905)', async () => {
  const dir = await repo();
  const name = `b-${['jdoe', 'corp.com'].join('@')}.txt`;
  git(dir, 'rm', '-q', 'a.txt');
  const sha = await commit(dir, name, 'nothing private\n', 'replace a note');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['a.txt', name], 'git lists the deleted file first');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1, err);
  assert.match(err, new RegExp(`^${sha} file 2 of git show --name-only: email in the file name$`, 'm'));
  for (const part of ['jdoe', 'corp']) assert.ok(!err.includes(part), `the log holds “${part}”`);
});
