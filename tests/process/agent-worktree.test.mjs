// #1709 against real git: an Antigravity agent with no folder of its own gets its own worktree of the project’s
// repository (server/adapters/agent-worktree.mjs), on its own branch, and two agents get two. The plugin each turn
// writes stays out of git status there too (agy-plugin.mjs’s excludePlugin). The unit tests use a fake git
// (tests/agent-worktree.test.mjs); this one only needs git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentWorktree, branchFor } from '../../server/adapters/agent-worktree.mjs';
import { decideAgyTool } from '../../server/adapters/agy-hook.mjs';
import { excludePlugin, PLUGIN_DIR } from '../../server/adapters/agy-plugin.mjs';

const home = await mkdtemp(join(tmpdir(), 'pb-test-worktree-'));
after(() => rm(home, { recursive: true, force: true }));
// Git as a fresh install would be, whoever runs this: no hooks, signing or templates from the person’s own config.
await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

/** A project folder that is a repository with one commit, and the data folder Postbox keeps worktrees in. @param {string} name */
async function project(name) {
  const folder = join(home, name, 'project');
  await mkdir(folder, { recursive: true });
  git(folder, ['init', '-q']);
  await writeFile(join(folder, 'README.md'), 'hello\n');
  git(folder, ['add', 'README.md']);
  git(folder, ['commit', '-q', '-m', 'first']);
  return { project: { id: `pr_${name}`, folder }, workRoot: join(home, name, 'data', 'work') };
}

test('#1709 two agents get two worktrees of the project, each on its own branch with the project’s files', async () => {
  const { project: p, workRoot } = await project('two');
  const a = await agentWorktree({ id: 'pe_a', handle: 'a' }, p, workRoot);
  const b = await agentWorktree({ id: 'pe_b', handle: 'b' }, p, workRoot);
  assert.notEqual(a, b);
  for (const [dir, handle] of [
    [a, 'a'],
    [b, 'b'],
  ]) {
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), branchFor({ handle }, p));
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
});
