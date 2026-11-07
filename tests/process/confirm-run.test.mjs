// Running a confirmed gh command (#852): a fake gh, a small Node script, reports what it was given, so these check the
// argument array, the empty folder it runs in, the environment it sees, the timeout and the output. It starts
// processes, so it’s here.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { runConfirmedGh } from '../../server/confirm-run.mjs';
import { tempDir } from '../temp-dirs.mjs';

const ALLOWED = ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN'];
const GIT = ['GH_CONFIG_DIR', 'GIT_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'];
const FIXED = ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'NO_COLOR', 'GH_PAGER', 'PAGER', 'GH_EDITOR', 'EDITOR', 'VISUAL', 'BROWSER'];

/** Writes an executable fake gh whose body is the given Node code, with a shebang naming this Node by its full path. */
function fakeGh(body) {
  const file = join(tempDir('pb-fake-gh-'), 'gh');
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const confirmFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith('pb-confirm-gh-'));

const REPORT = `const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd, env: process.env, cwdEntries: fs.readdirSync(cwd), stdin }));`;

test('#852 runConfirmedGh passes each argument as it was given, a value with spaces and quotes as one', async () => {
  const argv = ['pr', 'create', '--title', 'Fix "it" now; echo injected && echo $HOME', '--body', "it's `echo sub` | tr a b"];
  const run = await runConfirmedGh(argv, { bin: fakeGh(REPORT) });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(JSON.parse(run.output).argv, argv);
  assert.deepEqual(run.argv, argv);
  assert.notEqual(run.argv, argv, 'the argv returned is a copy');
  assert.equal(run.timedOut, false);
});

test('#852 r3: runConfirmedGh gives gh the checked body on stdin, and nothing more', async () => {
  const body = 'Fixes #852\n\nThe body the person read.\n';
  const run = await runConfirmedGh(['pr', 'comment', '1', '--repo', 'o/r', '--body-file', '-'], { bin: fakeGh(REPORT), input: body });
  assert.equal(run.status, 0, run.output);
  assert.equal(JSON.parse(run.output).stdin, body);
});

test('#852 runConfirmedGh runs gh in a new empty folder under the temp folder, and removes it after', async () => {
  const run = await runConfirmedGh(['repo', 'view'], { bin: fakeGh(REPORT) });
  const seen = JSON.parse(run.output);
  assert.ok(basename(seen.cwd).startsWith('pb-confirm-gh-'), seen.cwd);
  assert.equal(dirname(seen.cwd), tmpdir());
  assert.deepEqual(seen.cwdEntries, []);
  assert.equal(existsSync(seen.cwd), false, 'the folder is removed once gh ends');
});

test('#852 runConfirmedGh gives gh only the allowed environment, never Postbox’s or SSH’s', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, { POSTBOX_X: 'leak', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_DIR: '/x/.git', GH_TOKEN: 'gho_test' });
  delete process.env.GH_CONFIG_DIR;
  const run = await runConfirmedGh(['auth', 'status'], { bin: fakeGh(REPORT) });
  const { env, stdin } = JSON.parse(run.output);
  const expected = [...ALLOWED.filter((key) => process.env[key] !== undefined), ...GIT, ...FIXED];
  assert.deepEqual(Object.keys(env).sort(), expected.sort());
  assert.equal(env.GH_TOKEN, 'gho_test');
  assert.equal(env.EDITOR, 'false');
  assert.equal(stdin, '', 'stdin is closed, so gh reads nothing and can’t wait on it');
});

test('#852 runConfirmedGh kills gh at the timeout and says it timed out', async () => {
  const bin = fakeGh('setTimeout(() => {}, 5000);');
  const started = Date.now();
  const run = await runConfirmedGh(['pr', 'list'], { bin, timeoutMs: 300 });
  assert.ok(Date.now() - started < 2000, `returned after ${Date.now() - started} ms`);
  assert.equal(run.timedOut, true);
  assert.notEqual(run.status, 0);
});

test('#852 runConfirmedGh returns stdout then stderr with colors and controls removed, cut at 4,000', async () => {
  const bin = fakeGh(`process.stdout.write('\\x1b[1;32mok\\x1b[0m\\r' + 'a'.repeat(5000)); process.stderr.write('\\x1b]0;t\\x07warn');`);
  const run = await runConfirmedGh(['pr', 'view'], { bin });
  assert.equal(run.output, `ok${'a'.repeat(3998)}…`);
  const short = await runConfirmedGh(['pr', 'view'], {
    bin: fakeGh(`process.stdout.write('\\x1b[31mout\\x1b[0m'); process.stderr.write('\\x1b]0;t\\x07err\\x1b[K');`),
  });
  assert.equal(short.output, 'out\nerr');
});

test('#852 runConfirmedGh reports a non-zero exit status, with what gh said', async () => {
  const run = await runConfirmedGh(['pr', 'merge'], { bin: fakeGh(`process.stderr.write('no such pr'); process.exit(3);`) });
  assert.equal(run.status, 3);
  assert.equal(run.output, 'no such pr');
  assert.equal(run.timedOut, false);
});

test('#852 runConfirmedGh reports a gh that can’t start as a failure, and still removes its folder', async () => {
  const before = new Set(confirmFolders());
  const run = await runConfirmedGh(['pr', 'list'], { bin: join(tempDir('pb-no-gh-'), 'missing-gh') });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /ENOENT/);
  assert.deepEqual(
    confirmFolders().filter((name) => !before.has(name)),
    [],
  );
});
