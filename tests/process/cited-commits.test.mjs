// #846: every commit a Markdown note or a pull request’s body cites is on GitHub, reachable from origin/main or the
// pull request’s own head. It runs real git, so it’s a process test: a bare “GitHub” remote and a clone of it in temp
// folders, with none of your own git config. The remote ends with a branch deleted (its commit still in the object
// store, as GitHub still serves it, but on no ref), a commit merged to main after the clone last fetched, and a pull
// request’s branch; the clone holds a commit on a local branch that was never pushed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { citedCommits, citedTokens, EXIT } from '../../tools/cited-commits.mjs';
import { tempDir } from '../temp-dirs.mjs';

const root = tempDir('pb-cited-commits-');
const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
await writeFile(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe', timeout: 10000 }).toString().trim();
/** Commits on the current branch with a message of its own, and returns its full id. */
const commit = (cwd, message) => {
  git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const remote = join(root, 'remote.git');
const seed = join(root, 'seed');
const work = join(root, 'work');
git(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
git(root, 'clone', '-q', remote, 'seed');
const BASE = commit(seed, 'base');
git(seed, 'push', '-q', 'origin', 'main');
git(seed, 'switch', '-q', '-c', 'gone');
const GONE = commit(seed, 'on a branch deleted on GitHub');
git(seed, 'push', '-q', 'origin', 'gone');
git(seed, 'switch', '-q', '-c', 'pr', 'main');
const PR_HEAD = commit(seed, 'the pull request’s head');
git(seed, 'push', '-q', 'origin', 'pr');
// The clone the check runs in has fetched each of those, origin/gone included.
git(root, 'clone', '-q', remote, 'work');
git(work, 'switch', '-q', '-c', 'scratch');
const LOCAL = commit(work, 'a local scratch commit, never pushed');
// Then, on GitHub, the branch is deleted and main moves on.
git(seed, 'push', '-q', 'origin', '--delete', 'gone');
git(seed, 'switch', '-q', 'main');
const MERGED = commit(seed, 'merged after the clone last fetched');
git(seed, 'push', '-q', 'origin', 'main');

/** The shortest prefix of `sha`, at least 7 long, with a letter a–f in it, as a note might cite it. */
const cite = (sha) => sha.slice(0, Math.max(7, sha.search(/[a-f]/) + 1));
const NOT_AN_OBJECT = 'feedface0badc0de';
const NUMBER = '33554432';

/** Runs the check on a note with `body` in the clone, and returns its exit code and lines. @param {string} body */
async function onNote(body) {
  const file = join(tempDir('pb-cited-note-'), 'note.md');
  await writeFile(file, body);
  const lines = [];
  const exit = citedCommits({ file }, { cwd: work, env, log: (line) => lines.push(line) });
  return { exit, lines, file };
}

test('#846’s done-when: of a reachable, a deleted branch’s and a never-pushed commit, a non-object and a number, only the two unreachable fail', async () => {
  const body = `Before ${cite(BASE)}, after ${GONE} (the scratch merge ${cite(LOCAL)}).\nNot a commit: ${NOT_AN_OBJECT}; a size: ${NUMBER}.\n`;
  const { exit, lines, file } = await onNote(body);
  assert.equal(exit, EXIT.fail);
  assert.deepEqual(lines, [
    `reachable: ${cite(BASE)} (origin/main)`,
    `unreachable: ${GONE} (not on origin/main)`,
    `unreachable: ${cite(LOCAL)} (not on origin/main)`,
    `not a known object: ${NOT_AN_OBJECT}`,
    `cited-commits ${file} commits=3 reachable=1 unreachable=2 unknown=1 -> FAIL`,
  ]);
});

test('a commit merged to main on GitHub since the clone last fetched counts as reachable, since the check fetches first', async () => {
  const { exit, lines, file } = await onNote(`Merged as ${MERGED}.`);
  assert.equal(exit, EXIT.pass);
  assert.deepEqual(lines, [`reachable: ${MERGED} (origin/main)`, `cited-commits ${file} commits=1 reachable=1 unreachable=0 unknown=0 -> PASS`]);
});

test('a token that isn’t an object is reported apart, and doesn’t fail the check', async () => {
  const { exit, lines } = await onNote(`At ${cite(BASE)}, not ${NOT_AN_OBJECT}.`);
  assert.equal(exit, EXIT.pass);
  assert.ok(lines.includes(`not a known object: ${NOT_AN_OBJECT}`), lines.join('\n'));
});

test('with --strict, a token that isn’t an object fails the check, as a never-pushed head from another clone would', async () => {
  const file = join(tempDir('pb-cited-note-'), 'note.md');
  await writeFile(file, `At ${cite(BASE)}, not ${NOT_AN_OBJECT}.`);
  const lines = [];
  const exit = citedCommits({ file }, { cwd: work, env, strict: true, log: (line) => lines.push(line) });
  assert.equal(exit, EXIT.fail);
  assert.equal(lines.at(-1), `cited-commits ${file} commits=1 reachable=1 unreachable=0 unknown=1 -> FAIL`);
});

test('a number with no letter a–f in it isn’t read as a cited commit at all', async () => {
  assert.deepEqual(citedTokens(`${NUMBER} 1234567 abc123 ${cite(BASE)} ${'a'.repeat(41)} ${cite(BASE)}`), [cite(BASE)]);
  const { exit, lines } = await onNote(`Its limit is ${NUMBER} bytes.`);
  assert.equal(exit, EXIT.pass);
  assert.ok(!lines.join('\n').includes(NUMBER), lines.join('\n'));
});

test('a commit on a branch other than main fails a note, and passes a pull request’s body only as that pull request’s head', async () => {
  const note = await onNote(`On the branch: ${PR_HEAD}.`);
  assert.equal(note.exit, EXIT.fail);
  assert.ok(note.lines.includes(`unreachable: ${PR_HEAD} (not on origin/main)`), note.lines.join('\n'));
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return { body: `Head ${PR_HEAD}; scratch ${cite(LOCAL)}.`, headRefOid: PR_HEAD };
  };
  const lines = [];
  const exit = citedCommits({ pr: 12 }, { cwd: work, env, gh, log: (line) => lines.push(line) });
  assert.deepEqual(calls, [['pr', 'view', '12', '--json', 'body,headRefOid']]);
  assert.equal(exit, EXIT.fail);
  assert.deepEqual(lines, [
    `reachable: ${PR_HEAD} (the pull request’s head)`,
    `unreachable: ${cite(LOCAL)} (not on origin/main or the pull request’s head)`,
    `cited-commits #12 head=${PR_HEAD.slice(0, 8)} commits=2 reachable=1 unreachable=1 unknown=0 -> FAIL`,
  ]);
});

test('a fetch that fails is an error, not a pass', async () => {
  const lone = tempDir('pb-cited-lone-');
  git(lone, 'init', '-q', '.');
  const file = join(lone, 'note.md');
  await writeFile(file, `At ${cite(BASE)}.`);
  const lines = [];
  const exit = citedCommits({ file }, { cwd: lone, env, log: (line) => lines.push(line) });
  assert.equal(exit, EXIT.error);
  assert.match(lines.at(-1) ?? '', /git fetch --prune origin failed: .* -> ERROR$/);
});
