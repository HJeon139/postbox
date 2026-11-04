// tools/lint-ternary.mjs against real git and the pinned Biome (#685): no new nested ternary on a line a change adds,
// while the ones already on main stay. Each case builds a throwaway repository in a temp folder, with a base commit
// holding an old nested ternary as origin/main, and runs the lint there. The unit tests can’t start processes
// (tests/guard.mjs), so it’s under tests/process/; the pure parts are in tests/lint-ternary.test.mjs.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const lint = fileURLToPath(new URL('../../tools/lint-ternary.mjs', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'pb-test-lint-ternary-'));
after(() => rmSync(home, { recursive: true, force: true }));
// Git as a fresh install would be, whoever runs this: no hooks, signing or templates from the person’s own config.
writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
delete gitEnv.CI;
delete gitEnv.BASE_REF;

// Line 2 holds the old nested ternary; the lines around it are for edits next to it.
const OLD = `export function pick(a, b) {
  return a ? 1 : b ? 2 : 3;
}
export const before = 1;
`;
const NEW_TERNARY = 'export const fresh = (a, b) => (a ? 1 : b ? 2 : 3);\n';

let count = 0;
/** A fresh repository whose base commit, also origin/main, holds old.mjs with its old nested ternary. */
function repo({ withOrigin = true } = {}) {
  const dir = join(home, `repo-${++count}`);
  mkdirSync(dir);
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: dir, env: gitEnv, stdio: 'pipe' }).toString();
  git('init', '-q');
  write(dir, 'old.mjs', OLD);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  if (withOrigin) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', '-c', 'work');
  return { dir, git };
}

function write(/** @type {string} */ dir, /** @type {string} */ path, /** @type {string} */ text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** The lint run in dir: its exit code and what it printed. */
function run(/** @type {string} */ dir, extraEnv = {}) {
  const r = spawnSync(process.execPath, [lint], { cwd: dir, env: { ...gitEnv, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('lint-ternary: a nested ternary on a line the change adds fails, in a new file whose path has a space and an é', () => {
  const { dir, git } = repo();
  write(dir, 'dir é/new file.mjs', `export const a = 1;\n${NEW_TERNARY}`);
  git('add', '.');
  git('commit', '-q', '-m', 'add');
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^dir é\/new file\.mjs:2: nested ternary on a changed line$/m);
});

test('lint-ternary: an old nested ternary on a line the change doesn’t touch passes', () => {
  const { dir, git } = repo();
  write(dir, 'other.mjs', 'export const plain = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'other');
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^lint-ternary: no nested ternary on a line changed since \w{8}\.$/m);
});

test('lint-ternary: removing an old nested ternary doesn’t pay for adding a new one in the same file', () => {
  const { dir, git } = repo();
  write(dir, 'old.mjs', `export function pick(a, b) {\n  return a || b;\n}\nexport const before = 1;\n${NEW_TERNARY}`);
  git('commit', '-q', '-am', 'trade');
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^old\.mjs:5: nested ternary on a changed line$/m);
});

test('lint-ternary: an edit on the line next to an old nested ternary passes', () => {
  const { dir, git } = repo();
  write(dir, 'old.mjs', OLD.replace('export function pick(a, b) {', 'export function pick(a, c) {'));
  git('commit', '-q', '-am', 'rename a parameter');
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
});

test('lint-ternary: a change not yet committed is checked too', () => {
  const { dir } = repo();
  write(dir, 'old.mjs', `${OLD}${NEW_TERNARY}`);
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^old\.mjs:5: nested ternary on a changed line$/m);
});

test('lint-ternary: a renamed file keeps its old nested ternary without failing', () => {
  const { dir, git } = repo();
  mkdirSync(join(dir, 'moved é'));
  renameSync(join(dir, 'old.mjs'), join(dir, 'moved é', 'old one.mjs'));
  git('add', '-A');
  git('commit', '-q', '-m', 'move');
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
});

test('lint-ternary: a renamed file whose edit adds a nested ternary fails, under its new name', () => {
  const { dir, git } = repo();
  git('mv', 'old.mjs', 'new.mjs');
  write(dir, 'new.mjs', `${OLD}${NEW_TERNARY}`);
  git('commit', '-q', '-am', 'move and add');
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^new\.mjs:5: nested ternary on a changed line$/m);
});

test('lint-ternary: a deleted file with an old nested ternary passes', () => {
  const { dir, git } = repo();
  git('rm', '-q', 'old.mjs');
  write(dir, 'other.mjs', 'export const plain = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'delete');
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
});

test('lint-ternary: with no base to compare with, it fails in CI and skips elsewhere', () => {
  const { dir } = repo({ withOrigin: false });
  write(dir, 'old.mjs', `${OLD}${NEW_TERNARY}`);
  const inCi = run(dir, { CI: '1' });
  assert.equal(inCi.status, 1, inCi.out);
  assert.match(inCi.out, /lint-ternary: failed, there is no origin\/main to compare with\./);
  const local = run(dir);
  assert.equal(local.status, 0, local.out);
  assert.match(local.out, /lint-ternary: skipped, there is no origin\/main to compare with\./);
});
