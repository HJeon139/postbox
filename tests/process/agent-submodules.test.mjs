// #1856 against real git: a project whose repository has submodules used to keep its Antigravity agents in the
// project’s own folder, taking turns. Each agent now gets its worktree with the submodules present, each a worktree of
// the person’s own submodule repository (server/adapters/agent-submodules.mjs): nothing is fetched, and the person’s
// checkouts are left as they were. The turn-end commit records what the agent changed in them
// (server/adapters/agent-worktree-commit.mjs).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSubmodules } from '../../server/adapters/agent-submodules.mjs';
import { agentWorktree, branchFor } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { runGit } from '../../server/ledger-git.mjs';
import { git, home, withSubmodule } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };

/** A project with the submodule `lib`, and the agent’s branch in both repositories. @param {string} name */
async function withLib(name) {
  const s = await withSubmodule(name);
  return { ...s, branch: branchFor(agent, s.p) };
}

test('#1856 an agent in a project with submodules gets a worktree of its own with them present, and nothing is fetched', async () => {
  const s = await withLib('sub');
  const before = s.persons();
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  assert.notEqual(dir, s.p.folder, 'not the project’s folder, where turns wait for each other');
  assert.equal(await readFile(join(dir, 'lib', 'README.md'), 'utf8'), 'hello\n', 'the submodule’s files are there');
  assert.equal(git(join(dir, 'lib'), ['rev-parse', 'HEAD']), git(s.p.folder, ['rev-parse', 'HEAD:lib']), 'at the commit the project names');
  assert.equal(git(join(dir, 'lib'), ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), s.branch, 'on the agent’s branch, in the submodule’s repository');
  assert.equal(git(dir, ['status', '--porcelain']), '', 'and the worktree is clean');
  assert.deepEqual(s.persons(), before, 'the person’s checkouts are as they were');
  assert.deepEqual(s.logs, []);
  // A second agent gets its own, submodule and all.
  const other = await agentWorktree({ id: 'pe_b', handle: 'b' }, s.p, s.workRoot, s.o);
  assert.notEqual(other, dir);
  assert.equal(await readFile(join(other, 'lib', 'README.md'), 'utf8'), 'hello\n');
});

test('#1856 a submodule the person’s checkout doesn’t hold stays empty in the agent’s worktree, and the log names it', async () => {
  const s = await withLib('sub-away');
  // A second checkout of the project, cloned without its submodule: `lib` is an empty folder there.
  const folder = join(home, 'sub-away', 'clone');
  git(home, ['clone', '-q', s.p.folder, folder]);
  const p = { id: 'pr_sub-away-clone', folder };
  const dir = await agentWorktree(agent, p, s.workRoot, s.o);
  assert.notEqual(dir, folder);
  assert.deepEqual(await readdir(join(dir, 'lib')), []);
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /submodule lib .*isn’t checked out in the project’s folder/);
  // Its work beside the empty submodule is still committed.
  await writeFile(join(dir, 'top.txt'), 'the agent’s work\n');
  assert.equal(await commitTurn(dir, agent, p, s.workRoot, s.o), true);
  assert.equal(git(folder, ['show', `${branchFor(agent, p)}:top.txt`]), 'the agent’s work\n');
  assert.equal(git(folder, ['rev-parse', `${branchFor(agent, p)}:lib`]), git(folder, ['rev-parse', 'HEAD:lib']), 'the submodule is where it was');
});

test('#1856 the turn-end commit records what the agent changed in a submodule, on its branch there and in the project', async () => {
  const s = await withLib('sub-commit');
  const before = s.persons();
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  await writeFile(join(dir, 'lib', 'new.txt'), 'in the submodule\n');
  await writeFile(join(dir, 'top.txt'), 'in the project\n');
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), true);
  const lib = join(s.p.folder, 'lib');
  assert.equal(git(lib, ['show', `${s.branch}:new.txt`]), 'in the submodule\n', 'committed in the submodule’s repository, on the agent’s branch');
  assert.equal(git(s.p.folder, ['show', `${s.branch}:top.txt`]), 'in the project\n');
  assert.equal(git(s.p.folder, ['rev-parse', `${s.branch}:lib`]), git(lib, ['rev-parse', s.branch]), 'and the project’s commit names that commit');
  assert.match(git(lib, ['log', '-1', '--format=%an <%ae> / %cn', s.branch]), /^@gem <gem@postbox\.invalid> \/ Postbox$/m);
  assert.equal(git(dir, ['status', '--porcelain']), '', 'nothing is left uncommitted');
  assert.deepEqual(s.persons(), before, 'the person’s checkouts are as they were');
  assert.deepEqual(s.logs, []);
  // A turn that changed only the submodule is committed too.
  await writeFile(join(dir, 'lib', 'new.txt'), 'changed again\n');
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), true);
  assert.equal(git(s.p.folder, ['rev-parse', `${s.branch}:lib`]), git(lib, ['rev-parse', s.branch]));
  assert.equal(git(lib, ['show', `${s.branch}:new.txt`]), 'changed again\n');
  // And one that changed nothing commits nothing.
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), false);
  assert.deepEqual(s.logs, []);
});

test('#1856 a submodule standing behind the commit the agent’s branch names isn’t taken back by the turn-end commit', async () => {
  const s = await withLib('sub-behind');
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  // The person moves the submodule on and commits that; the agent merges it, and its own checkout of the submodule
  // stays where it was, as git leaves it.
  const lib = join(s.p.folder, 'lib');
  await writeFile(join(lib, 'more.txt'), 'the person’s\n');
  git(lib, ['add', 'more.txt']);
  git(lib, ['commit', '-q', '-m', 'more']);
  git(s.p.folder, ['commit', '-q', '-am', 'move lib on']);
  git(dir, ['merge', '-q', 'main']);
  const named = git(s.p.folder, ['rev-parse', 'HEAD:lib']);
  assert.notEqual(git(join(dir, 'lib'), ['rev-parse', 'HEAD']), named, 'the agent’s submodule is behind');
  await writeFile(join(dir, 'top.txt'), 'in the project\n');
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), true);
  assert.equal(git(s.p.folder, ['rev-parse', `${s.branch}:lib`]), named, 'the project’s commit still names the person’s');
});

test('#1856 a submodule whose .git the agent pointed at a git folder of its own runs nothing that folder’s config names', async () => {
  const s = await withLib('sub-fake');
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  const marker = join(home, 'sub-fake', 'ran');
  // A git folder written as plain files in the worktree, whose config names a program for the submodule’s files.
  const fake = join(dir, 'g');
  await mkdir(join(fake, 'objects'), { recursive: true });
  await mkdir(join(fake, 'refs', 'heads'), { recursive: true });
  // At the commit the project names, so git sees no change of commit and looks inside for changed files.
  await writeFile(join(fake, 'HEAD'), git(s.p.folder, ['rev-parse', 'HEAD:lib']));
  // Both of git’s ways to run one: a filter for its files, and a program asked which files changed.
  await writeFile(
    join(fake, 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${marker};:"\n[filter "x"]\n\tclean = "touch ${marker}; cat"\n`,
  );
  await writeFile(join(dir, 'lib', '.git'), 'gitdir: ../g\n');
  await writeFile(join(dir, 'lib', '.gitattributes'), '* filter=x\n');
  await writeFile(join(dir, 'lib', 'README.md'), 'changed\n');
  await commitTurn(dir, agent, s.p, s.workRoot, s.o);
  assert.equal(existsSync(marker), false, 'the agent’s filter didn’t run');
  // The commit ran in the record the person’s submodule repository keeps, so the work is on the agent’s branch there.
  assert.equal(git(join(s.p.folder, 'lib'), ['show', `${s.branch}:README.md`]), 'changed\n');
});

test('#1856 a link the agent put at a submodule’s own folder isn’t followed: nothing is checked out where it points', async () => {
  const s = await withLib('sub-link');
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  // Its submodule’s worktree gone from git’s records, as for one left empty, and its folder a link to an empty folder
  // outside the worktree, as the agent could leave it before Postbox makes the submodule again (after a restart).
  git(join(s.p.folder, 'lib'), ['worktree', 'remove', '--force', join(dir, 'lib')]);
  const away = join(home, 'sub-link', 'away');
  await mkdir(away);
  await symlink(away, join(dir, 'lib'));
  const left = await addSubmodules((cwd, args) => runGit(cwd, args), { repo: s.p.folder, dir, branch: s.branch });
  assert.deepEqual(await readdir(away), [], 'nothing was checked out through the link');
  assert.deepEqual(left, [{ path: 'lib', why: 'its folder in the worktree leads outside it' }]);
});

test('#1856 a submodule folder the agent replaced with a link to the person’s checkout isn’t committed through the link', async () => {
  const s = await withLib('sub-swap');
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  const lib = join(s.p.folder, 'lib');
  await writeFile(join(lib, 'mine.txt'), 'the person’s, not committed\n');
  await rm(join(dir, 'lib'), { recursive: true, force: true });
  await symlink(lib, join(dir, 'lib'));
  await writeFile(join(dir, 'top.txt'), 'in the project\n');
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), true, 'the project’s own work is still committed');
  assert.doesNotMatch(git(lib, ['ls-tree', '--name-only', s.branch]), /mine\.txt/, 'the person’s file isn’t on the agent’s branch');
  assert.equal(git(lib, ['status', '--porcelain']), '?? mine.txt\n', 'and their checkout is as they left it');
});

test('#1856 a repository the agent added to its index itself, neither a submodule nor the project’s, leaves the turn uncommitted', async () => {
  const s = await withLib('sub-foreign');
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  const sha = git(s.p.folder, ['rev-parse', 'HEAD']).trim();
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},foreign`]);
  await writeFile(join(dir, 'top.txt'), 'in the project\n');
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), false);
  assert.match(s.logs.join('\n'), /holds a repository of its own/);
});
