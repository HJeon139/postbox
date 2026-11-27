// #1856 against real git: the guards around an agent’s submodule worktrees (server/adapters/agent-submodules.mjs) and
// their turn-end commit (server/adapters/agent-worktree-commit.mjs), each with the case it’s there for. Found in
// review of #1859, where these guards had no failing test.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSubmodules } from '../../server/adapters/agent-submodules.mjs';
import { agentWorktree, branchFor, gitTimeoutFor } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { runGit } from '../../server/ledger-git.mjs';
import { git, home, withSubmodule } from './agent-worktree-fixture.mjs';

const agent = { id: 'pe_a', handle: 'gem' };
/** git as Postbox runs it. @type {import('../../server/adapters/agent-worktree.mjs').Git} */
const realGit = (cwd, args) => runGit(cwd, args, gitTimeoutFor(args));

/**
 * An agent’s worktree of a project with one submodule, and that submodule’s folder in each.
 * @param {string} name @param {string} [path]
 */
async function made(name, path = 'lib') {
  const s = await withSubmodule(name, path);
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  const again = () => addSubmodules(realGit, { repo: s.p.folder, dir, branch: branchFor(agent, s.p) });
  return { ...s, dir, again, branch: branchFor(agent, s.p), theirs: join(s.p.folder, path), mine: join(dir, path) };
}

test('#1856 a link on the way to a submodule’s folder isn’t followed: nothing is checked out beyond it', async () => {
  const w = await made('sub-parent-link', 'vendor/lib');
  // The submodule’s worktree gone from git’s records, and the folder above it a link to one outside the worktree.
  git(w.theirs, ['worktree', 'remove', '--force', w.mine]);
  await rm(join(w.dir, 'vendor'), { recursive: true, force: true });
  const away = join(home, 'sub-parent-link', 'away');
  await mkdir(join(away, 'lib'), { recursive: true });
  await symlink(away, join(w.dir, 'vendor'));
  assert.deepEqual(await w.again(), [{ path: 'vendor/lib', why: 'its folder in the worktree leads outside it' }]);
  assert.deepEqual(await readdir(join(away, 'lib')), [], 'nothing was checked out through the link');
});

test('#1856 a submodule’s worktree git didn’t finish making, as when Postbox stopped mid-add, is removed and made again', async () => {
  const w = await made('sub-unfinished');
  // Git’s own marker for a worktree it’s still making, and a file it had only half written.
  await writeFile(join(git(w.mine, ['rev-parse', '--git-dir']).trim(), 'locked'), 'initializing\n');
  await writeFile(join(w.mine, 'README.md'), '');
  assert.deepEqual(await w.again(), []);
  assert.equal(await readFile(join(w.mine, 'README.md'), 'utf8'), 'hello\n', 'made again whole');
  assert.equal(git(w.mine, ['status', '--porcelain']), '');
});

test('#1856 a submodule add git stops partway leaves an empty folder and no record, and says why', async () => {
  const w = await made('sub-stopped');
  git(w.theirs, ['worktree', 'remove', '--force', w.mine]);
  await mkdir(w.mine);
  // As git stopped by its timeout: the worktree is there, and git reports failure.
  /** @type {import('../../server/adapters/agent-worktree.mjs').Git} */
  const stopping = async (cwd, args) => {
    const out = await realGit(cwd, args);
    return args.includes('worktree') && args.includes('add') ? { code: 1, stdout: '', stderr: 'fatal: stopped\n' } : out;
  };
  const left = await addSubmodules(stopping, { repo: w.p.folder, dir: w.dir, branch: w.branch });
  assert.deepEqual(left, [{ path: 'lib', why: 'fatal: stopped' }]);
  assert.deepEqual(await readdir(w.mine), [], 'the folder git keeps for a submodule, empty');
  assert.equal(git(w.theirs, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1, 'no record of it in the person’s repository');
  // The next turn makes it whole.
  assert.deepEqual(await w.again(), []);
  assert.equal(await readFile(join(w.mine, 'README.md'), 'utf8'), 'hello\n');
});

test('#1856 a submodule worktree whose own record names another folder to work in isn’t committed', async () => {
  const w = await made('sub-core-worktree');
  const elsewhere = join(home, 'sub-core-worktree', 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'key'), 'from outside the agent’s folders\n');
  // A setting of this worktree’s own, which git reads once the repository keeps settings per worktree. The
  // repository’s shared config names the person’s checkout for every worktree, and that one doesn’t count.
  const admin = git(w.mine, ['rev-parse', '--git-dir']).trim();
  git(w.theirs, ['config', 'extensions.worktreeConfig', 'true']);
  await writeFile(join(admin, 'config.worktree'), `[core]\n\tworktree = ${elsewhere}\n`);
  await writeFile(join(w.mine, 'new.txt'), 'in the submodule\n');
  await commitTurn(w.dir, agent, w.p, w.workRoot, w.o);
  assert.match(w.logs.join('\n'), /lib: its worktree’s record names another folder to work in/);
  assert.doesNotMatch(git(w.theirs, ['ls-tree', '-r', '--name-only', w.branch]), /new\.txt|key/, 'nothing committed in the submodule');
});

test('#1856 a repository the agent named with a pattern in its index isn’t taken for one of the project’s submodules', async () => {
  const s = await withSubmodule('sub-pattern', 'vendor/lib');
  const dir = await agentWorktree(agent, s.p, s.workRoot, s.o);
  // `vendor/*` matches the person’s own submodule when git reads it as a pattern.
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(s.p.folder, ['rev-parse', 'HEAD']).trim()},vendor/*`]);
  await writeFile(join(dir, 'top.txt'), 'in the project\n');
  assert.equal(await commitTurn(dir, agent, s.p, s.workRoot, s.o), false);
  assert.match(s.logs.join('\n'), /holds a repository of its own/);
});
