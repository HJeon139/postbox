// #1709 against real git: an Antigravity agent with no folder of its own gets its own worktree of the project’s
// repository (server/adapters/agent-worktree.mjs), on its own branch, and two agents get two. The plugin each turn
// writes stays out of git status there too (agy-plugin.mjs’s excludePlugin). The unit tests use a fake git
// (tests/agent-worktree.test.mjs); this one only needs git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { agentWorktree, branchFor } from '../../server/adapters/agent-worktree.mjs';
import { decideAgyTool } from '../../server/adapters/agy-hook.mjs';
import { excludePlugin, PLUGIN_DIR } from '../../server/adapters/agy-plugin.mjs';
import { AntigravityCliAdapter } from '../../server/adapters/antigravity-cli.mjs';

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
});

/**
 * An Antigravity adapter over a fake agy, as 1.5.18 with its hook confirmed, in the project’s data folder, and a turn
 * that returns the rules file agy found in its folder. @param {{ folder: string }} p @param {string} workRoot @param {string} name
 */
function agyOver(p, workRoot, name) {
  /** @type {string[]} */
  let rules = [];
  const spawnImpl = (/** @type {string} */ _bin, /** @type {string[]} */ _args, /** @type {any} */ opts) => {
    const file = join(opts.cwd, PLUGIN_DIR, 'rules', 'AGENTS.md');
    rules.push(existsSync(file) ? readFileSync(file, 'utf8') : '');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    setImmediate(() => {
      child.stdout.end(`${JSON.stringify({ type: 'result', result: 'ok', session_id: 'c1' })}\n`);
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const settingsFile = join(home, name, 'settings.json');
  const adapter = new AntigravityCliAdapter({
    workRoot,
    settingsFile,
    spawnImpl: /** @type {any} */ (spawnImpl),
    env: {},
    version: '1.5.18',
    hookProbe: async () => true,
  });
  const persona = { id: 'pe_a', handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [], description: '', instructions: '' };
  const ctx = { signal: new AbortController().signal, mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1', persona, project: p, handles: ['gem'], state: {} };
  const quiet = { saveState() {}, pathOf: () => null, text() {}, activity() {}, status() {}, reported() {} };
  /** The rules file agy read for one turn. @param {string} text */
  const turn = async (text) => {
    rules = [];
    await adapter.deliver({}, { kind: 'user', text }, { ...ctx, ...quiet }).catch(() => {});
    return rules.find(Boolean) ?? '';
  };
  return { adapter, turn, folder: () => adapter.folderFor(persona, p) };
}

test('#1709 an Antigravity turn in an agent’s worktree is told its branch and that the person merges, in agy’s rules file', async () => {
  const { project: p, workRoot } = await project('told');
  const agy = agyOver(p, workRoot, 'told');
  const rules = await agy.turn('Go.');
  assert.match(rules, /## Where you work/);
  assert.ok(rules.includes('branch postbox/pr_told-gem-pe_a'), rules.slice(-900));
  assert.ok(rules.includes(p.folder));
  assert.match(rules, /which the person merges/);
});

test('#1709 the note names the branch the worktree is on now, or says it’s on a commit, not a branch', async () => {
  const { project: p, workRoot } = await project('branches');
  const agy = agyOver(p, workRoot, 'branches');
  const dir = await agy.folder();
  git(dir, ['checkout', '-q', '-b', 'gem-own-name']);
  assert.ok((await agy.turn('Again.')).includes('branch gem-own-name'));
  git(dir, ['checkout', '-q', '--detach']);
  assert.ok((await agy.turn('Detached.')).includes('on a commit, not a branch: check out postbox/pr_branches-gem-pe_a'));
});

test('#1709 an agy without the hook gets no note: it would refuse the reads the note promises, and its rules have no room', async () => {
  const { project: p, workRoot } = await project('unhooked');
  const agy = agyOver(p, workRoot, 'unhooked');
  agy.adapter.version = '1.4.0';
  const rules = await agy.turn('Old agy.');
  assert.ok(rules, 'agy ran with its rules file');
  assert.doesNotMatch(rules, /## Where you work/);
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
