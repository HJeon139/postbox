// The commit privacy scan (tools/scan-commits-privacy.mjs) against real git, on the names of the files a commit adds,
// copies or renames (#785): a name is published as surely as what the file holds, and the log CI prints names no part
// of a private one (#784). It runs git and node, so it’s under tests/process/, beside
// tests/process/scan-commits-privacy.test.mjs.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commit, git, HOME_PATH, repo, scan } from './scan-commits-git.mjs';

test('a commit that adds a file named after an address fails, and its log holds no part of the address (#784, #785)', async () => {
  const dir = await repo();
  const address = ['jdoe', 'corp.com'].join('@');
  const sha = await commit(dir, `${address}.txt`, 'nothing private\n', 'add a note');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  assert.match(err, new RegExp(`^${sha} file 1 of git show --name-only: email in the file name$`, 'm'));
  for (const part of ['jdoe', 'corp']) assert.ok(!err.includes(part), `the log holds “${part}”`);
});

test('a file named after an address that holds private text too prints no part of the name or the text (#784, #785)', async () => {
  const dir = await repo();
  const address = ['jdoe', 'corp.com'].join('@');
  const sha = await commit(dir, `n-${address}.md`, `mail ${address}\n${HOME_PATH}\n`, 'add a note');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1);
  const findings = err.split('\n').filter((line) => line.startsWith(sha));
  const where = `${sha} file 1 of git show --name-only`;
  assert.deepEqual(findings, [`${where}: email in the file name`, `${where}: home path at line 2`, `${where}: email at line 1`]);
  for (const part of ['jdoe', 'corp', 'alice', 'Users', 'n-']) assert.ok(!err.includes(part), `the log holds “${part}”`);
});

test('a commit that adds an empty file named after an address fails, though it adds no line (#785)', async () => {
  const dir = await repo();
  const address = ['jdoe', 'corp.com'].join('@');
  const sha = await commit(dir, `${address}.txt`, '', 'add an empty note');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1, err);
  assert.match(err, new RegExp(`^${sha} file 1 of git show --name-only: email in the file name$`, 'm'));
  for (const part of ['jdoe', 'corp']) assert.ok(!err.includes(part), `the log holds “${part}”`);
});

test('a rename to a name that holds a home slug fails, though it changes no line (#785)', async () => {
  const dir = await repo();
  const named = `notes/${['', 'Users', 'alice', 'x'].join('-')}.txt`;
  await mkdir(join(dir, 'notes'));
  git(dir, 'mv', 'a.txt', named);
  git(dir, 'commit', '-q', '-m', 'rename');
  const sha = git(dir, 'rev-parse', '--short=7', 'HEAD');
  const { status, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 1, err);
  assert.match(err, new RegExp(`^${sha} file 1 of git show --name-only: home path in the file name$`, 'm'));
  for (const part of ['alice', 'Users']) assert.ok(!err.includes(part), `the log holds “${part}”`);
});

test('a commit that deletes a file whose name is private passes, as the name was added before the range (#785)', async () => {
  const dir = await repo();
  const named = `${['jdoe', 'corp.com'].join('@')}.txt`;
  git(dir, 'switch', '-q', 'main');
  await commit(dir, named, '');
  git(dir, 'switch', '-q', '-C', 'work');
  git(dir, 'rm', '-q', named);
  git(dir, 'commit', '-q', '-m', 'remove a note');
  const { status, out, err } = scan(dir, 'main..HEAD');
  assert.equal(status, 0, err);
  assert.match(out, /1 commit added 0 lines in 0 files, none of them private/);
});
