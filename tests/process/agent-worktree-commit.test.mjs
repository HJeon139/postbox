// #1709: the commit at the end of an Antigravity turn lands only in the worktree Postbox made, on the agent’s own
// branch. git runs in that worktree’s record in the project’s repository, named outright, never found through
// anything in the agent’s folders, which the agent can write. Against real git, in the shared temp home.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { git, home, project } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };

/** An agent’s worktree with a file it wrote, and what each check reads. @param {string} name */
async function wrote(name) {
  const { project: p, workRoot } = await project(name);
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  /** @type {string[]} */
  const logs = [];
  const commit = () => commitTurn(dir, agent, p, workRoot, { log: (l) => logs.push(l) });
  return { p, workRoot, dir, logs, commit, admin: git(dir, ['rev-parse', '--absolute-git-dir']).trim() };
}

/** Whether a file’s contents are anywhere in the project’s object store. @param {string} folder @param {string} file */
const stored = (folder, file) => {
  const id = git(folder, ['hash-object', file]).trim();
  return git(folder, ['cat-file', '--batch-all-objects', '--batch-check']).includes(id);
};

test('#1709 a worktree whose .git names another repository still commits only on the agent’s branch', async () => {
  const w = await wrote('elsewhere');
  const head = git(w.p.folder, ['rev-parse', 'HEAD']);
  // As if the agent pointed its worktree’s .git at the project’s own repository.
  await writeFile(join(w.dir, '.git'), `gitdir: ${join(w.p.folder, '.git')}\n`);
  assert.equal(await w.commit(), true);
  assert.equal(git(w.p.folder, ['rev-parse', 'HEAD']), head, 'the person’s branch is as it was');
  assert.equal(git(w.p.folder, ['status', '--porcelain']), '', 'and so is the person’s checkout');
  assert.equal(git(w.p.folder, ['show', 'postbox/pr_elsewhere-gem-pe_a:agent.txt']), 'the agent’s work\n', 'on its branch');
});

test('#1709 a git folder the agent wrote, naming a folder outside its own, gets nothing read from that folder', async () => {
  const w = await wrote('fake-repo');
  const secret = join(home, 'fake-repo', 'secret');
  await mkdir(secret, { recursive: true });
  await writeFile(join(secret, 'key'), 'a key from outside the agent’s folders\n');
  // A git folder written as plain files in the worktree, whose config names that folder to work in.
  const fake = join(w.dir, 'g');
  await mkdir(join(fake, 'objects'), { recursive: true });
  await mkdir(join(fake, 'refs', 'heads'), { recursive: true });
  await writeFile(join(fake, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(fake, 'config'), `[core]\n\trepositoryformatversion = 0\n\tworktree = ${secret}\n`);
  await writeFile(join(w.dir, '.git'), 'gitdir: g\n');
  await w.commit();
  assert.equal(stored(w.p.folder, join(secret, 'key')), false, 'not in the project’s objects');
  assert.deepEqual(readdirSync(join(fake, 'objects')), [], 'nor in the agent’s');
});

test('#1709 a worktree record that names another folder to work in commits nothing', async () => {
  const w = await wrote('core-worktree');
  const secret = join(home, 'core-worktree', 'secret');
  await mkdir(secret, { recursive: true });
  await writeFile(join(secret, 'key'), 'another key\n');
  git(w.p.folder, ['config', 'core.worktree', secret]);
  assert.equal(await w.commit(), false);
  assert.match(w.logs[0] ?? '', /names another folder to work in/);
  assert.equal(stored(w.p.folder, join(secret, 'key')), false);
});

test('#1709 a worktree on another branch, or on no branch, commits nothing', async () => {
  const w = await wrote('other-branch');
  git(w.dir, ['checkout', '-q', '-b', 'somewhere-else']);
  const head = git(w.dir, ['rev-parse', 'HEAD']);
  assert.equal(await w.commit(), false);
  assert.match(w.logs.at(-1) ?? '', /isn’t on its own branch/);
  git(w.dir, ['checkout', '-q', '--detach']);
  assert.equal(await w.commit(), false);
  assert.equal(git(w.dir, ['rev-parse', 'HEAD']), head, 'nothing committed');
});

test('#1709 a bisect, or a cherry-pick or revert resolved but not committed, keeps the work uncommitted', async () => {
  for (const [name, start, kind] of /** @type {const} */ ([
    ['bisect', (/** @type {string} */ dir) => git(dir, ['bisect', 'start']), 'bisect'],
    ['picked', (/** @type {string} */ dir) => halfDone(dir, 'cherry-pick'), 'cherry-pick'],
    ['reverted', (/** @type {string} */ dir) => halfDone(dir, 'revert'), 'revert'],
  ])) {
    const w = await wrote(name);
    start(w.dir);
    const head = git(w.dir, ['rev-parse', 'HEAD']);
    assert.equal(await w.commit(), false, name);
    assert.match(w.logs.at(-1) ?? '', new RegExp(`a ${kind} is in progress`), name);
    assert.equal(git(w.dir, ['rev-parse', 'HEAD']), head, name);
  }
});

/**
 * A cherry-pick or a revert that stopped on a conflict, which the agent resolved and staged but didn’t commit: no
 * conflict left in the status, only git’s file for the operation. @param {string} dir @param {'cherry-pick' | 'revert'} op
 */
function halfDone(dir, op) {
  const branch = git(dir, ['branch', '--show-current']).trim();
  git(dir, ['checkout', '-q', '-b', `${op}-side`]);
  writeFileSync(join(dir, 'README.md'), 'side\n');
  git(dir, ['commit', '-qam', 'side']);
  const side = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '-q', branch]);
  writeFileSync(join(dir, 'README.md'), op === 'revert' ? 'side\n' : 'ours\n');
  git(dir, ['commit', '-qam', 'ours']);
  if (op === 'revert') {
    writeFileSync(join(dir, 'README.md'), 'later\n');
    git(dir, ['commit', '-qam', 'later']);
  }
  try {
    git(dir, op === 'revert' ? ['revert', '--no-edit', 'HEAD~1'] : ['cherry-pick', side]);
  } catch {} // the conflict
  writeFileSync(join(dir, 'README.md'), 'resolved\n');
  git(dir, ['add', 'README.md']);
}

test('#1709 a repository nested in the worktree isn’t committed, and runs nothing its own config names', async () => {
  const w = await wrote('nested');
  // Turn one: a repository of its own in a subfolder, committed at the turn’s end as a nested repository.
  const sub = join(w.dir, 'sub');
  await mkdir(sub, { recursive: true });
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, 'f'), 'one\n');
  git(sub, ['add', 'f']);
  git(sub, ['commit', '-qm', 'one']);
  assert.equal(await w.commit(), false, 'a repository of its own isn’t committed');
  assert.match(w.logs.at(-1) ?? '', /holds a repository of its own/);
  // As if one had reached the index anyway: its config names a program for its files, and one of them changes.
  git(w.dir, ['add', 'sub']);
  git(w.dir, ['commit', '-qm', 'nested']);
  const marker = join(home, 'nested', 'ran');
  writeFileSync(join(sub, '.git', 'config'), `${readFileSync(join(sub, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = "touch ${marker}; cat"\n`);
  writeFileSync(join(sub, '.gitattributes'), 'f filter=x\n');
  writeFileSync(join(sub, 'f'), 'two\n');
  writeFileSync(join(w.dir, 'agent.txt'), 'more of the agent’s work\n');
  assert.equal(await w.commit(), false);
  assert.equal(existsSync(marker), false, 'the nested repository’s filter didn’t run');
});

test('#1709 a repository that writes relative worktree paths still has the turn’s work committed', async () => {
  const { project: p, workRoot } = await project('relative');
  git(p.folder, ['config', 'worktree.useRelativePaths', 'true']);
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  assert.equal(await commitTurn(dir, agent, p, workRoot, { log: () => {} }), true);
});
