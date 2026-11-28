// #1932: once Postbox has made the commit at the end of an Antigravity turn (#1709, #1844), its index goes into the
// worktree’s index.lock and is renamed over the index. If that write or rename failed after the branch had moved, the
// worktree’s index stayed the old one, and the agent’s own next `git commit` would undo the turn on its branch; a
// failed write also made the turn’s end reject. Git orders it the other way, its new index before HEAD moves, and so
// does Postbox now: a failure here leaves the branch and the index agreeing, with the turn’s work still in the folder.
// Against real git, in the shared temp home, with git’s runner wrapped to break the step right after the commit.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree, gitTimeoutFor } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { runGit } from '../../server/ledger-git.mjs';
import { git, project } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };

/**
 * A turn that wrote a file, and its commit with `broken(index, admin)` run right after git makes the commit object
 * (commit-tree), before Postbox puts the index in place. @param {string} name
 * @param {(index: string, admin: string) => void} broken
 */
async function turnBrokenAfterCommit(name, broken) {
  const { project: p, workRoot } = await project(name);
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  const admin = git(dir, ['rev-parse', '--absolute-git-dir']).trim();
  const before = git(dir, ['rev-parse', 'HEAD']).trim();
  /** @type {string[]} */
  const logs = [];
  const wrapped = async (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{ index?: string }} */ o = {}) => {
    const out = await runGit(cwd, args, { ...gitTimeoutFor(args), ...o });
    if (o.index && args.includes('commit-tree')) broken(o.index, admin);
    return out;
  };
  const result = await commitTurn(dir, agent, p, workRoot, { git: wrapped, log: (l) => logs.push(l) }).then(
    (committed) => ({ committed }),
    (e) => ({ rejected: String(e) }),
  );
  return { dir, admin, before, logs, result };
}

/** Whether the worktree’s index holds exactly HEAD’s tree: what the agent’s next own commit would keep. @param {string} dir */
const indexIsHead = (dir) => runGit(dir, ['diff', '--cached', '--quiet', 'HEAD']).then((r) => r.code === 0);

test('#1932 a commit index Postbox can’t write leaves the branch where it was, the index with it, and the turn’s end resolves', async () => {
  const w = await turnBrokenAfterCommit('landing-write', (index) => chmodSync(index, 0o000));
  assert.deepEqual(w.result, { committed: false }, 'the turn’s end doesn’t reject');
  assert.equal(git(w.dir, ['rev-parse', 'HEAD']).trim(), w.before, 'the branch didn’t move');
  assert.equal(await indexIsHead(w.dir), true, 'the index agrees with the branch, so the agent’s next commit undoes nothing');
  assert.ok(existsSync(join(w.dir, 'agent.txt')), 'the turn’s work is still in the folder, for the next commit');
  assert.ok(!existsSync(join(w.admin, 'index.lock')), 'the lock is gone');
  assert.match(w.logs.join('\n'), /didn’t commit @gem’s work.*couldn’t write the commit’s index/);
});

test('#1932 a commit index Postbox can’t rename into place leaves the branch where it was, and says so', async () => {
  // Something in the index’s place that a rename can’t replace: a folder with a file in it.
  const w = await turnBrokenAfterCommit('landing-rename', (_index, admin) => {
    rmSync(join(admin, 'index'), { force: true });
    mkdirSync(join(admin, 'index', 'in-the-way'), { recursive: true });
  });
  assert.deepEqual(w.result, { committed: false });
  assert.equal(git(w.dir, ['rev-parse', 'HEAD']).trim(), w.before, 'the branch didn’t move');
  assert.ok(!existsSync(join(w.admin, 'index.lock')), 'the lock is gone');
  assert.match(w.logs.join('\n'), /didn’t commit @gem’s work.*couldn’t put the commit’s index in place/);
});

test('#1932 a commit the agent makes before Postbox moves its branch is kept: the branch moves only from the tip Postbox read', async () => {
  const { project: p, workRoot } = await project('landing-race');
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  /** @type {string[]} */
  const logs = [];
  let theirs = '';
  const wrapped = async (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{ index?: string }} */ o = {}) => {
    // The agent commits just as Postbox is about to move the branch, once the lock is gone.
    if (args.includes('update-ref')) {
      git(dir, ['commit', '-q', '--allow-empty', '-m', 'the agent’s own']);
      theirs = git(dir, ['rev-parse', 'HEAD']).trim();
    }
    return runGit(cwd, args, { ...gitTimeoutFor(args), ...o });
  };
  assert.equal(await commitTurn(dir, agent, p, workRoot, { git: wrapped, log: (l) => logs.push(l) }), false);
  assert.ok(theirs, 'the agent committed');
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), theirs, 'the agent’s commit is the tip, not overwritten');
  assert.match(logs.join('\n'), /didn’t commit @gem’s work.*git refused/);
});

test('#1932 a file the status listed but that’s gone by the add makes no empty commit, as git commit wouldn’t', async () => {
  const { project: p, workRoot } = await project('landing-nothing');
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  const before = git(dir, ['rev-parse', 'HEAD']).trim();
  const wrapped = async (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{ index?: string }} */ o = {}) => {
    // A process the agent left running removes the file between Postbox’s status and its add.
    if (args.includes('add')) rmSync(join(dir, 'agent.txt'));
    return runGit(cwd, args, { ...gitTimeoutFor(args), ...o });
  };
  assert.equal(await commitTurn(dir, agent, p, workRoot, { git: wrapped, log: () => {} }), false);
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), before, 'no commit was made');
});
