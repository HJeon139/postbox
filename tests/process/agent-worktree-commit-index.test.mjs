// #1844: the commit at the end of an Antigravity turn (#1709) is built from a copy of the worktree’s index that Postbox
// keeps outside the agent’s folders, so what a process the agent left running stages in the worktree while the
// commit runs doesn’t reach it. Against real git, in the shared temp home, with git’s runner wrapped to act at a
// chosen command as such a process could.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree, gitTimeoutFor } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { runGit } from '../../server/ledger-git.mjs';
import { git, home, project } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };
const branch = (/** @type {string} */ name) => `postbox/pr_${name}-gem-pe_a`;

/**
 * An agent’s worktree with a file it wrote, and git’s runner wrapped: `at(args)` runs before each command Postbox
 * gives git, and `indexes` keeps every private index the commit named. @param {string} name
 * @param {(args: string[], dir: string) => void} [at]
 */
async function turn(name, at = () => {}) {
  const { project: p, workRoot } = await project(name);
  const dir = await agentWorktree(agent, p, workRoot);
  await writeFile(join(dir, 'agent.txt'), 'the agent’s work\n');
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const indexes = [];
  const wrapped = async (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {{ index?: string }} */ o = {}) => {
    if (o.index) indexes.push(o.index);
    at(args, dir);
    return runGit(cwd, args, { ...gitTimeoutFor(args), ...o });
  };
  const commit = () => commitTurn(dir, agent, p, workRoot, { git: wrapped, log: (l) => logs.push(l) });
  return { p, dir, logs, indexes, commit };
}

/**
 * A repository in an ignored folder of the worktree, whose own config names a clean filter for a file that has changed,
 * which touches `marker` when git runs it. Returns a function that stages it in the worktree’s own index as a gitlink.
 * @param {string} dir @param {string} marker
 */
async function nestedWithFilter(dir, marker) {
  writeFileSync(join(dir, '.gitignore'), 'sub/\n');
  writeFileSync(join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
  const sub = join(dir, 'sub');
  await mkdir(sub, { recursive: true });
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, '.gitattributes'), 'f filter=x\n');
  writeFileSync(join(sub, 'f'), 'one\n');
  git(sub, ['add', 'f', '.gitattributes']);
  git(sub, ['commit', '-qm', 'one']);
  writeFileSync(join(sub, '.git', 'config'), `${readFileSync(join(sub, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = "touch ${marker}; cat"\n`);
  writeFileSync(join(sub, 'f'), 'two\n');
  return () => git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(sub, ['rev-parse', 'HEAD']).trim()},sub`]);
}

test('#1844 a gitlink staged in the worktree as the commit’s add runs runs nothing, and stays off the branch', async () => {
  const marker = join(home, 'staged-at-add', 'ran');
  let slip = () => '';
  let slipped = false;
  const w = await turn('staged-at-add', (args) => {
    if (!args.includes('add') || slipped) return;
    slip();
    slipped = true;
  });
  slip = await nestedWithFilter(w.dir, marker);
  assert.equal(await w.commit(), true, w.logs.join('\n'));
  assert.equal(slipped, true, 'the gitlink was staged as the add ran');
  assert.equal(existsSync(marker), false, 'the nested repository’s filter didn’t run');
  const files = git(w.p.folder, ['ls-tree', '-r', branch('staged-at-add')]);
  assert.doesNotMatch(files, /^160000 /m, 'no nested repository on the agent’s branch');
  assert.deepEqual(
    files
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t')[1]),
    ['.gitignore', '.gitmodules', 'README.md', 'agent.txt'],
    'only what the agent wrote, and the project’s file',
  );
});

test('#1844 a repository made in the worktree as the commit’s add runs is refused, and doesn’t reach the branch', async () => {
  const w = await turn('made-at-add', (args, dir) => {
    if (!args.includes('add') || existsSync(join(dir, 'late'))) return;
    git(dir, ['init', '-q', 'late']);
    writeFileSync(join(dir, 'late', 'f'), 'one\n');
    git(join(dir, 'late'), ['add', 'f']);
    git(join(dir, 'late'), ['commit', '-qm', 'one']);
  });
  const head = git(w.dir, ['rev-parse', 'HEAD']);
  assert.equal(await w.commit(), false);
  assert.match(w.logs.at(-1) ?? '', /holds a repository of its own/);
  assert.equal(git(w.dir, ['rev-parse', 'HEAD']), head, 'nothing committed');
  assert.doesNotMatch(git(w.p.folder, ['ls-tree', '-r', branch('made-at-add')]), /^160000 /m, 'no nested repository on the agent’s branch');
  assert.doesNotMatch(git(w.dir, ['ls-files', '--stage']), /^160000 /m, 'nor in the worktree’s own index');
});

test('#1844 after the commit the worktree’s own index matches it, and Postbox’s copy is gone', async () => {
  const w = await turn('index-after');
  git(w.dir, ['add', 'agent.txt']);
  writeFileSync(join(w.dir, 'agent.txt'), 'the agent’s work, changed after it staged it\n');
  writeFileSync(join(w.dir, 'more.txt'), 'never staged\n');
  assert.equal(await w.commit(), true, w.logs.join('\n'));
  assert.equal(git(w.dir, ['status', '--porcelain', '--untracked-files=all']), '', 'nothing staged or changed against the commit');
  assert.equal(git(w.dir, ['show', 'HEAD:agent.txt']), 'the agent’s work, changed after it staged it\n');
  assert.ok(w.indexes.length > 0, 'the commit named an index of its own');
  for (const index of new Set(w.indexes)) assert.equal(existsSync(dirname(index)), false, `${index}’s folder is removed`);
});

test('#1844 Postbox’s copy of the index is removed when the commit is refused too', async () => {
  const w = await turn('index-refused');
  git(w.dir, ['init', '-q', 'own']);
  writeFileSync(join(w.dir, 'own', 'f'), 'one\n');
  assert.equal(await w.commit(), false);
  assert.match(w.logs.at(-1) ?? '', /holds a repository of its own/);
  assert.ok(w.indexes.length > 0, 'the commit named an index of its own');
  for (const index of new Set(w.indexes)) assert.equal(existsSync(dirname(index)), false, `${index}’s folder is removed`);
});

test('#1844 every step of the commit reads Postbox’s copy, not what’s staged in the worktree after it', async () => {
  let staged = false;
  const w = await turn('staged-at-status', (args, dir) => {
    if (!args.includes('status') || staged) return;
    staged = true;
    // A conflict and a gitlink in the worktree’s own index, which neither the status nor the gitlink check may see.
    const blob = git(dir, ['rev-parse', 'HEAD:README.md']).trim();
    const unmerged = [1, 2, 3].map((n) => `100644 ${blob} ${n}\tREADME.md\n`).join('');
    execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: `0 ${'0'.repeat(40)}\tREADME.md\n${unmerged}` });
    git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(dir, ['rev-parse', 'HEAD']).trim()},ghost`]);
  });
  assert.equal(await w.commit(), true, w.logs.join('\n'));
  assert.equal(staged, true, 'the worktree’s index changed as the status ran');
  assert.equal(git(w.dir, ['show', 'HEAD:agent.txt']), 'the agent’s work\n');
  assert.doesNotMatch(git(w.p.folder, ['ls-tree', '-r', branch('staged-at-status')]), /^160000 /m, 'no gitlink on the agent’s branch');
});
