// #1709 against real git: an Antigravity agent with no folder of its own gets its own worktree of the project’s
// repository (server/adapters/agent-worktree.mjs), on its own branch, and two agents get two. The plugin each turn
// writes stays out of git status there too (agy-plugin.mjs’s excludePlugin). The unit tests use a fake git
// (tests/agent-worktree.test.mjs); this one only needs git.

import assert from 'node:assert/strict';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentWorktree, branchFor } from '../../server/adapters/agent-worktree.mjs';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { decideAgyTool } from '../../server/adapters/agy-hook.mjs';
import { excludePlugin, PLUGIN_DIR } from '../../server/adapters/agy-plugin.mjs';
import { git, home, project } from './agent-worktree-fixture.mjs';

test('#1709 two agents get two worktrees of the project, each on its own branch with the project’s files', async () => {
  const { project: p, workRoot } = await project('two');
  const a = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  const b = await agentWorktree({ id: 'pe_b', handle: 'b' }, p, workRoot);
  assert.notEqual(a, b);
  for (const [dir, handle] of [
    [a, 'a'],
    [b, 'b'],
  ]) {
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), branchFor({ id: `pe_${handle}`, handle }, p));
    assert.equal(git(dir, ['show', 'HEAD:README.md']), 'hello\n');
  }
  // As git lists them: by their real paths, which a temp folder’s link (macOS’s /var) changes.
  const list = git(p.folder, ['worktree', 'list', '--porcelain']);
  assert.ok(list.includes(`worktree ${await realpath(a)}\n`) && list.includes(`worktree ${await realpath(b)}\n`), list);
  // A second turn uses the same worktree.
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot), a);
});

test('#1709 the plugin a turn writes in a worktree stays out of git status', async () => {
  const { project: p, workRoot } = await project('plugin');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  assert.equal(await excludePlugin(dir), true);
  await mkdir(join(dir, PLUGIN_DIR), { recursive: true });
  await writeFile(join(dir, PLUGIN_DIR, 'plugin.json'), '{}\n');
  assert.equal(git(dir, ['status', '--porcelain']), '');
});

test('#1709 a repository with no commit yet leaves the agent in the project’s folder', async () => {
  const folder = join(home, 'empty', 'project');
  await mkdir(folder, { recursive: true });
  git(folder, ['init', '-q']);
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, { id: 'pr_empty', folder }, join(home, 'empty', 'data', 'work'));
  // Git would make an empty worktree there, without the project’s files.
  assert.equal(dir, folder);
  assert.equal(git(folder, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1, 'no worktree made');
});

test('#1709 a worktree git didn’t finish making, as when Postbox stopped mid-add, is removed and made again', async () => {
  const { project: p, workRoot } = await project('unfinished');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  // git worktree add marks a worktree it’s still making with a `locked` file in its admin folder, saying `initializing`
  // under LC_ALL=C (read from git 2.52 mid-add, held there by a slow smudge filter).
  const admin = git(dir, ['rev-parse', '--git-dir']).trim();
  await writeFile(join(admin, 'locked'), 'initializing\n');
  await writeFile(join(dir, 'README.md'), '');
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot), dir);
  assert.equal(git(dir, ['status', '--porcelain']), '', 'made again whole');
  assert.equal(git(dir, ['show', 'HEAD:README.md']), 'hello\n');
});

test('#1709 a worktree someone locked keeps the work in it, and the agent goes on working there', async () => {
  const { project: p, workRoot } = await project('locked');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  await writeFile(join(dir, 'draft.md'), 'not committed\n');
  for (const lock of [
    ['worktree', 'lock', dir],
    ['worktree', 'lock', '--reason', 'keep this', dir],
  ]) {
    git(dir, lock);
    assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot), dir);
    assert.equal(git(dir, ['status', '--porcelain']), '?? draft.md\n', 'the uncommitted work is still there');
    git(dir, ['worktree', 'unlock', dir]);
  }
});

test('#1709 a locked worktree whose folder someone moved keeps its lock, and git still works in the moved folder', async () => {
  const { project: p, workRoot } = await project('moved');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  await writeFile(join(dir, 'draft.md'), 'not committed\n');
  git(dir, ['worktree', 'lock', '--reason', 'on a removable drive', dir]);
  const moved = join(home, 'moved', 'elsewhere');
  await rename(dir, moved);
  // Git refuses to add over a locked worktree whose folder is gone, so the agent works in the project’s folder.
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot, { log: () => {} }), p.folder);
  assert.match(git(p.folder, ['worktree', 'list', '--porcelain']), /^locked on a removable drive$/m, 'the lock stays');
  assert.equal(git(moved, ['status', '--porcelain']), '?? draft.md\n', 'git still works in the moved folder');
});

test('#1709 making an agent’s worktree keeps the person’s own worktree whose folder is away, and remakes its own deleted one', async () => {
  const { project: p, workRoot } = await project('away');
  const mine = join(home, 'away', 'mine');
  git(p.folder, ['worktree', 'add', '-q', '-b', 'mine', mine]);
  // As a drive that isn’t mounted: `git worktree prune` would forget it, and git would no longer work there.
  await rename(mine, `${mine}.away`);
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  await rm(dir, { recursive: true, force: true });
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot), dir, 'its own deleted worktree is made again');
  await rename(`${mine}.away`, mine);
  assert.equal(git(mine, ['status', '--porcelain']), '', 'git still works in the person’s worktree');
});

test('#1709 git’s record of a worktree still being made, its folder since deleted, is cleared so the next turn makes it', async () => {
  const { project: p, workRoot } = await project('stopped-hard');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  // As after a hard stop mid-add (git’s marker, read from git 2.52 mid-add) and the half-made folder deleted by hand.
  const admin = git(dir, ['rev-parse', '--git-dir']).trim();
  await writeFile(join(admin, 'locked'), 'initializing\n');
  await rm(dir, { recursive: true, force: true });
  const quiet = { log: () => {} };
  // Git refuses the add over its own record; the record goes, and the next turn makes the worktree.
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot, quiet), p.folder);
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot, quiet), dir);
  assert.equal(git(dir, ['show', 'HEAD:README.md']), 'hello\n');
});

test('#1709 in Auto, routine git runs with no card in an agent’s real worktree, as git lays it out', async () => {
  const { project: p, workRoot } = await project('auto-git');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  const decide = (/** @type {string[]} */ folders) =>
    decideAgyTool({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } }, { mode: 'auto', folders, cwd: dir, home }).decision;
  assert.equal(decide([dir]), 'allow');
  // Given the project’s own folder too, the agent could have written the config git reads there.
  assert.equal(decide([dir, p.folder]), 'ask');
  // With the project’s folder among what it may only read, routine git still runs, and still only in its own folders.
  const run = (/** @type {string} */ CommandLine) =>
    decideAgyTool({ toolCall: { name: 'run_command', args: { CommandLine } } }, { mode: 'auto', folders: [dir], reads: [p.folder], cwd: dir, home }).decision;
  assert.equal(run('git status'), 'allow');
  assert.equal(run(`git diff ${join(p.folder, 'README.md')}`), 'ask', 'read roots are for read-only commands, not git');
});

test('#1709 an add stopped before git wrote its record’s HEAD is still removed and made again', async () => {
  const { project: p, workRoot } = await project('no-head');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  const admin = git(dir, ['rev-parse', '--git-dir']).trim();
  // As an add killed after it wrote the worktree’s .git and its marker, and before the record’s HEAD.
  await writeFile(join(admin, 'locked'), 'initializing\n');
  await rm(join(admin, 'HEAD'));
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot, { log: () => {} }), p.folder, 'this turn can’t use it');
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot), dir, 'the next makes it whole');
  assert.equal(git(dir, ['show', 'HEAD:README.md']), 'hello\n');
});

test('#1709 a worktree whose record in the repository is gone isn’t used: the agent works in the project’s folder, and the log says why', async () => {
  const { project: p, workRoot } = await project('recloned');
  const dir = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  const admin = git(dir, ['rev-parse', '--git-dir']).trim();
  // As when the repository is cloned again at the same path: the worktree’s .git names a record that’s gone.
  await rm(admin, { recursive: true, force: true });
  /** @type {string[]} */
  const logs = [];
  assert.equal(await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot, { log: (l) => logs.push(l) }), p.folder);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /couldn’t make a worktree for @a/);
});

test('#1709 Postbox never commits in the project’s own folder: only in an agent’s worktree', async () => {
  const { project: p, workRoot } = await project('own-folder');
  await writeFile(join(p.folder, 'person.md'), 'the person’s draft\n');
  const head = git(p.folder, ['rev-parse', 'HEAD']);
  assert.equal(await commitTurn(p.folder, { handle: 'gem' }, p, workRoot), false);
  assert.equal(git(p.folder, ['rev-parse', 'HEAD']), head);
  assert.equal(git(p.folder, ['status', '--porcelain']), '?? person.md\n', 'the person’s work is left as it was');
  // In a worktree that changed nothing, nothing is committed and nothing is logged.
  const dir = await agentWorktree({ id: 'pe_a', handle: 'gem' }, p, workRoot);
  /** @type {string[]} */
  const logs = [];
  assert.equal(await commitTurn(dir, { handle: 'gem' }, p, workRoot, { log: (l) => logs.push(l) }), false);
  assert.deepEqual(logs, []);
});
