// #1844: the commit at the end of an Antigravity turn (#1709) holds git’s lock on the worktree’s index from the copy
// it’s built from until the commit’s index is in place, as git does. A lock someone else holds leaves the turn
// uncommitted; a commit leaves the worktree’s index with what git knew of each file, so the agent’s own next commit
// starts from Postbox’s. Against real git, in the shared temp home.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { git, home, project } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };

/**
 * An agent’s worktree with a file it wrote and a tracked file it changed. `commit` runs the turn-end commit with the
 * system temp folder set to one of the test’s own, and returns what it left there. @param {string} name
 */
async function turn(name) {
  const { project: p, workRoot } = await project(name);
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  await writeFile(join(dir, 'README.md'), 'edited by the agent\n');
  const admin = git(dir, ['rev-parse', '--absolute-git-dir']).trim();
  /** @type {string[]} */
  const logs = [];
  const temp = join(home, name, 'tmp');
  await mkdir(temp, { recursive: true });
  const commit = async () => {
    // os.tmpdir() reads TMPDIR at each call, so the copy’s folder is made in the test’s own.
    const was = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    try {
      const made = await commitTurn(dir, agent, p, workRoot, { log: (l) => logs.push(l) });
      return { made, left: readdirSync(temp) };
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
  };
  return { p, dir, admin, lock: join(admin, 'index.lock'), logs, commit };
}

test('#1844 an index.lock someone else holds at the turn’s end leaves the turn uncommitted, and the lock as it was', async () => {
  const w = await turn('lock-held');
  writeFileSync(w.lock, 'a git that was killed\n');
  const head = git(w.dir, ['rev-parse', 'HEAD']);
  const { made, left } = await w.commit();
  assert.equal(made, false, w.logs.join('\n'));
  assert.match(w.logs.at(-1) ?? '', /another git is using its index, so it stays uncommitted/);
  assert.equal(git(w.dir, ['rev-parse', 'HEAD']), head, 'HEAD didn’t move');
  assert.equal(readFileSync(w.lock, 'utf8'), 'a git that was killed\n', 'the lock isn’t Postbox’s, so it’s left alone');
  assert.deepEqual(left, [], 'Postbox’s folder for its copy is removed');
});

test('#1844 an agent that clears a stale index.lock and commits after a turn undoes nothing the turn left', async () => {
  const w = await turn('lock-cleared');
  writeFileSync(w.lock, '');
  await w.commit();
  // What an agent does on “index.lock: File exists”: removes it, then commits its own file.
  rmSync(w.lock);
  writeFileSync(join(w.dir, 'c.txt'), 'c\n');
  git(w.dir, ['add', 'c.txt']);
  git(w.dir, ['commit', '-qm', 'c']);
  assert.deepEqual(git(w.dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean), ['c.txt'], 'the agent’s commit touches only its file');
  assert.equal(git(w.dir, ['status', '--porcelain']), ' M README.md\n?? agent.txt\n', 'the turn’s work is still in the worktree, uncommitted');
});

test('#1844 a file the turn changed keeps what git knew of it in the worktree’s index after the commit', async () => {
  const w = await turn('lock-stat');
  const { made } = await w.commit();
  assert.equal(made, true, w.logs.join('\n'));
  // Read before any status, which would refresh the index and write back what it found.
  for (const file of ['README.md', 'agent.txt']) {
    assert.doesNotMatch(git(w.dir, ['ls-files', '--debug', file]), /size: 0\b/, `${file}’s size is known, so the next status needn’t read it again`);
  }
});

test('#1844 after a commit the lock is gone, the worktree’s index is the commit’s, and so is Postbox’s folder', async () => {
  const w = await turn('lock-committed');
  const { made, left } = await w.commit();
  assert.equal(made, true, w.logs.join('\n'));
  assert.equal(existsSync(w.lock), false, 'no index.lock left');
  assert.equal(git(w.dir, ['status', '--porcelain', '--untracked-files=all']), '', 'nothing staged or changed against the commit');
  assert.deepEqual(left, [], 'Postbox’s folder for its copy is removed');
});

test('#1844 after a refused commit the lock is gone, and the worktree’s index is as it was', async () => {
  const w = await turn('lock-refused');
  git(w.dir, ['init', '-q', 'own']);
  writeFileSync(join(w.dir, 'own', 'f'), 'one\n');
  const before = readFileSync(join(w.admin, 'index'));
  const { made, left } = await w.commit();
  assert.equal(made, false);
  assert.match(w.logs.at(-1) ?? '', /holds a repository of its own/);
  assert.equal(existsSync(w.lock), false, 'no index.lock left');
  assert.deepEqual(readFileSync(join(w.admin, 'index')), before, 'the worktree’s index is untouched');
  assert.deepEqual(left, [], 'Postbox’s folder for its copy is removed');
});

test('#1844 the agent’s own next commit after Postbox’s holds only what it staged', async () => {
  const w = await turn('lock-next');
  const { made } = await w.commit();
  assert.equal(made, true, w.logs.join('\n'));
  writeFileSync(join(w.dir, 'c.txt'), 'c\n');
  git(w.dir, ['add', 'c.txt']);
  git(w.dir, ['commit', '-qm', 'c']);
  assert.deepEqual(git(w.dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean), ['c.txt'], 'the agent’s commit touches only its file');
});
