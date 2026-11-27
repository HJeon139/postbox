// #1709: the commit at the end of an Antigravity turn lands only in the worktree Postbox made, on the agent’s own
// branch. git runs in that worktree’s record in the project’s repository, named outright, never found through
// anything in the agent’s folders, which the agent can write. Against real git, in the shared temp home.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree, gitTimeoutFor } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { runGit } from '../../server/ledger-git.mjs';
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
  // As if one had reached the index anyway, with a .gitmodules asking that it be read whatever git's config says: its
  // config names a program for its files, and one of them changes.
  writeFileSync(join(w.dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
  git(w.dir, ['add', 'sub', '.gitmodules']);
  git(w.dir, ['commit', '-qm', 'nested']);
  const marker = join(home, 'nested', 'ran');
  writeFileSync(join(sub, '.git', 'config'), `${readFileSync(join(sub, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = "touch ${marker}; cat"\n`);
  writeFileSync(join(sub, '.gitattributes'), 'f filter=x\n');
  writeFileSync(join(sub, 'f'), 'two\n');
  writeFileSync(join(w.dir, 'agent.txt'), 'more of the agent’s work\n');
  assert.equal(await w.commit(), false);
  assert.equal(existsSync(marker), false, 'the nested repository’s filter didn’t run');
  // The work ledger reads the same worktree’s status.
  await runGit(w.dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  await runGit(w.dir, ['diff', 'HEAD']);
  assert.equal(existsSync(marker), false, 'the ledger’s reads didn’t run it either');
});

/**
 * A worktree with a repository in an ignored folder, whose own config names a program for a file that has changed, and a
 * commit that tries to put it in the worktree’s index as the turn-end commit runs, as a process the agent left running
 * could: before its status (when: 'status') or between its status and its add (when: 'add'). git refuses it while
 * Postbox holds the index’s lock (#1844); either way, `tries` counts that the process ran.
 * @param {string} name @param {'status'|'add'} when
 */
async function slippedIn(name, when) {
  const w = await wrote(name);
  writeFileSync(join(w.dir, '.gitignore'), 'sub/\n');
  writeFileSync(join(w.dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
  const sub = join(w.dir, 'sub');
  await mkdir(sub, { recursive: true });
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, '.gitattributes'), 'f filter=x\n');
  writeFileSync(join(sub, 'f'), 'one\n');
  git(sub, ['add', 'f', '.gitattributes']);
  git(sub, ['commit', '-qm', 'one']);
  const marker = join(home, name, 'ran');
  writeFileSync(join(sub, '.git', 'config'), `${readFileSync(join(sub, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = "touch ${marker}; cat"\n`);
  writeFileSync(join(sub, 'f'), 'two\n');
  const sha = git(sub, ['rev-parse', 'HEAD']).trim();
  let tries = 0;
  const slip = () => {
    tries++;
    try {
      git(w.dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},sub`]);
    } catch {
      // Refused on Postbox’s lock on the index: the process still ran, which is what the test needs.
    }
  };
  let statuses = 0;
  const gitThen = async (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{ index?: string }} */ o = {}) => {
    if (args.includes('status') && when === 'status') slip();
    const out = await runGit(cwd, args, { ...gitTimeoutFor(args), ...o });
    if (args.includes('status') && when === 'add' && statuses++ === 0) slip();
    return out;
  };
  await commitTurn(w.dir, agent, w.p, w.workRoot, { git: gitThen, log: (l) => w.logs.push(l) });
  return { tries, ran: existsSync(marker), branch: git(w.p.folder, ['ls-tree', '-r', `postbox/pr_${name}-gem-pe_a`]) };
}

test('#1709 a nested repository that reaches the index after the check runs nothing its own config names', async () => {
  for (const when of /** @type {const} */ (['status', 'add'])) {
    const r = await slippedIn(`slipped-${when}`, when);
    assert.ok(r.tries > 0, `the process tried to stage the nested repository before the ${when}`);
    assert.equal(r.ran, false, `the nested repository’s filter didn’t run when it slipped in before the ${when}`);
    assert.doesNotMatch(r.branch, /^160000 /m, 'no nested repository on the agent’s branch');
  }
});

test('#1709 a nested repository whose name git quotes in its status isn’t committed either', async () => {
  const w = await wrote('quoted');
  const sub = join(w.dir, 's\u00fc');
  await mkdir(sub, { recursive: true });
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, 'f'), 'one\n');
  git(sub, ['add', 'f']);
  git(sub, ['commit', '-qm', 'one']);
  writeFileSync(join(w.dir, '.gitmodules'), '[submodule "s"]\n\tpath = s\u00fc\n\turl = ./s\n\tignore = none\n');
  assert.equal(await w.commit(), false);
  assert.match(w.logs.at(-1) ?? '', /holds a repository of its own/);
  assert.doesNotMatch(git(w.dir, ['ls-tree', '-r', 'HEAD']), /^160000 /m, 'no nested repository on the agent’s branch');
});

test('#1709 a repository that writes relative worktree paths still has the turn’s work committed', async () => {
  const { project: p, workRoot } = await project('relative');
  git(p.folder, ['config', 'worktree.useRelativePaths', 'true']);
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  assert.equal(await commitTurn(dir, agent, p, workRoot, { log: () => {} }), true);
});

test('#1709 each agent’s commit uses its own record among the repository’s worktrees, and none once that record is gone', async () => {
  const { project: p, workRoot } = await project('records');
  /** @type {string[]} */
  const logs = [];
  const log = (/** @type {string} */ l) => logs.push(l);
  const agents = [agent, { id: 'pe_b', handle: 'gpt' }];
  const dirs = [await agentWorktree(agents[0], p, workRoot), await agentWorktree(agents[1], p, workRoot)];
  for (const [i, who] of agents.entries()) {
    await writeFile(join(dirs[i], 'agent.txt'), `@${who.handle}’s work\n`);
    assert.equal(await commitTurn(dirs[i], who, p, workRoot, { log }), true, logs.join('\n'));
    assert.equal(git(p.folder, ['show', `postbox/pr_records-${who.handle}-${who.id}:agent.txt`]), `@${who.handle}’s work\n`);
  }
  // Its record gone, as after the repository is cloned again: nothing is committed, and the log says why.
  await writeFile(join(dirs[0], 'more.txt'), 'more\n');
  await rm(git(dirs[0], ['rev-parse', '--absolute-git-dir']).trim(), { recursive: true });
  assert.equal(await commitTurn(dirs[0], agent, p, workRoot, { log }), false);
  assert.match(logs.at(-1) ?? '', /isn’t one the project’s repository lists/);
});
