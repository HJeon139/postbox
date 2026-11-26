// #1709 against real git: an Antigravity turn in an agent’s own worktree, with a fake agy that records the rules file
// and the hook’s environment it found, and writes a file when asked. The worktree itself is
// tests/process/agent-worktree.test.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { commitTurn } from '../../server/adapters/agent-worktree-commit.mjs';
import { PLUGIN_DIR } from '../../server/adapters/agy-plugin.mjs';
import { AntigravityCliAdapter } from '../../server/adapters/antigravity-cli.mjs';
import { git, home, project } from './agent-worktree-fixture.mjs';

/**
 * An Antigravity adapter over a fake agy, as 1.5.18 with its hook confirmed, in the project’s data folder, and a turn
 * that returns the rules file agy found in its folder. @param {{ folder: string }} p @param {string} workRoot @param {string} name
 */
function agyOver(p, workRoot, name, { mode = 'ask', hook = true, writes = '' } = {}) {
  /** @type {string[]} */
  let rules = [];
  /** @type {string[][]} */
  let reads = [];
  const spawnImpl = (/** @type {string} */ _bin, /** @type {string[]} */ _args, /** @type {any} */ opts) => {
    const file = join(opts.cwd, PLUGIN_DIR, 'rules', 'AGENTS.md');
    rules.push(existsSync(file) ? readFileSync(file, 'utf8') : '');
    reads.push(JSON.parse(opts.env?.POSTBOX_AGY_READS ?? '[]'));
    // As the agent writing a file with its file tools: no git of its own.
    if (writes) writeFileSync(join(opts.cwd, writes), 'the agent’s work\n');
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
    hookProbe: async () => hook,
  });
  const persona = { id: 'pe_a', handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: mode, tools: ['web.fetch'], description: '', instructions: '' };
  const ctx = { signal: new AbortController().signal, mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1', persona, project: p, handles: ['gem'], state: {} };
  const quiet = { saveState() {}, pathOf: () => null, text() {}, activity() {}, status() {}, reported() {} };
  /** The rules file agy read for one turn. @param {string} text */
  const turn = async (text) => {
    rules = [];
    reads = [];
    await adapter.deliver({}, { kind: 'user', text }, { ...ctx, ...quiet }).catch(() => {});
    return rules.find(Boolean) ?? '';
  };
  return { adapter, turn, folder: () => adapter.folderFor(persona, p), reads: () => reads };
}

test('#1709 an Antigravity turn in an agent’s worktree is told its branch and that the person merges, in agy’s rules file', async () => {
  const { project: p, workRoot } = await project('told');
  const agy = agyOver(p, workRoot, 'told');
  const rules = await agy.turn('Go.');
  assert.match(rules, /## Where you work/);
  assert.ok(rules.includes('branch postbox/pr_told-gem-pe_a'), rules.slice(-900));
  assert.ok(rules.includes(p.folder));
  assert.match(rules, /which the person merges/);
  // And the hook is given the project’s folder to read with no card (5a0c7ae7): read only, beside its own folders.
  assert.ok(
    agy.reads().some((r) => r.includes(p.folder)),
    JSON.stringify(agy.reads()),
  );
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
  // Nor one whose hook doesn’t check out.
  const failed = agyOver(p, workRoot, 'unhooked-failed', { hook: false });
  assert.doesNotMatch(await failed.turn('Hook failed.'), /## Where you work/);
});

test('#1709 Run everything, where agy refuses nothing, gets the note', async () => {
  const { project: p, workRoot } = await project('bypass');
  const agy = agyOver(p, workRoot, 'bypass', { mode: 'bypass' });
  const rules = await agy.turn('Go.');
  assert.match(rules, /## Where you work/);
  assert.match(rules, /which the person merges/);
});

test('#1709 what a turn leaves in an agent’s worktree is committed on its branch, by the agent, with no card and no Shell', async () => {
  const { project: p, workRoot } = await project('committed');
  const agy = agyOver(p, workRoot, 'committed', { writes: 'notes.md' });
  const dir = await agy.folder();
  const before = git(dir, ['rev-list', '--count', 'HEAD']).trim();
  await agy.turn('Write your notes.');
  assert.equal(git(dir, ['status', '--porcelain']), '', 'nothing left uncommitted');
  assert.equal(Number(git(dir, ['rev-list', '--count', 'HEAD'])), Number(before) + 1);
  assert.equal(git(dir, ['log', '-1', '--format=%an|%cn|%s']).trim(), '@gem|Postbox|@gem’s work at the end of a turn');
  assert.equal(git(p.folder, ['show', 'postbox/pr_committed-gem-pe_a:notes.md']), 'the agent’s work\n', 'on its branch');
  assert.equal(git(p.folder, ['status', '--porcelain']), '', 'the project’s folder is as it was');
  assert.ok(!existsSync(join(p.folder, 'notes.md')));
});

test('#1709 a turn that changed nothing in its worktree makes no commit', async () => {
  const { project: p, workRoot } = await project('unchanged');
  const agy = agyOver(p, workRoot, 'unchanged');
  const dir = await agy.folder();
  const before = git(dir, ['rev-parse', 'HEAD']);
  await agy.turn('Just look.');
  assert.equal(git(dir, ['rev-parse', 'HEAD']), before);
});

test('#1709 the commit at a turn’s end runs no signing program from the repository’s config', async () => {
  const { project: p, workRoot } = await project('signed');
  // As a person who signs every commit: git would run gpg.program for this one.
  git(p.folder, ['config', 'commit.gpgSign', 'true']);
  git(p.folder, ['config', 'gpg.program', join(home, 'no-such-gpg')]);
  const agy = agyOver(p, workRoot, 'signed', { writes: 'notes.md' });
  const dir = await agy.folder();
  await agy.turn('Write your notes.');
  assert.equal(git(dir, ['status', '--porcelain']), '', 'committed, unsigned');
  assert.equal(git(dir, ['log', '-1', '--format=%an']).trim(), '@gem');
});

test('#1709 a merge the agent left half done isn’t committed as resolved: the work stays, and the log says why', async () => {
  const { project: p, workRoot } = await project('midway');
  const dir = await agyOver(p, workRoot, 'midway').folder();
  // Two branches that change one line, merged in the worktree with a conflict left in it.
  git(dir, ['checkout', '-q', '-b', 'other']);
  writeFileSync(join(dir, 'README.md'), 'theirs\n');
  git(dir, ['commit', '-qam', 'theirs']);
  git(dir, ['checkout', '-q', 'postbox/pr_midway-gem-pe_a']);
  writeFileSync(join(dir, 'README.md'), 'ours\n');
  git(dir, ['commit', '-qam', 'ours']);
  try {
    git(dir, ['merge', '-q', 'other']);
  } catch {} // the conflict
  const head = git(dir, ['rev-parse', 'HEAD']);
  /** @type {string[]} */
  const logs = [];
  assert.equal(await commitTurn(dir, { handle: 'gem' }, p, workRoot, { log: (l) => logs.push(l) }), false);
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'nothing committed');
  assert.match(logs[0] ?? '', /a merge is in progress there/);
});

test('#1709 a turn that only made files is committed, whatever status.showUntrackedFiles says, and the plugin isn’t in it', async () => {
  const { project: p, workRoot } = await project('untracked');
  git(p.folder, ['config', 'status.showUntrackedFiles', 'no']);
  const agy = agyOver(p, workRoot, 'untracked', { writes: 'new.md' });
  const dir = await agy.folder();
  await agy.turn('Write a new file.');
  const files = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
  assert.deepEqual(files, ['new.md'], 'the new file, and nothing of the plugin');
});

test('#1709 a conflict that leaves no marker file, as a stash pop does, isn’t committed with its markers', async () => {
  const { project: p, workRoot } = await project('stash');
  const dir = await agyOver(p, workRoot, 'stash').folder();
  writeFileSync(join(dir, 'README.md'), 'stashed\n');
  git(dir, ['stash', '-q']);
  writeFileSync(join(dir, 'README.md'), 'committed\n');
  git(dir, ['commit', '-qam', 'committed']);
  try {
    git(dir, ['stash', 'pop', '-q']);
  } catch {} // the conflict
  const head = git(dir, ['rev-parse', 'HEAD']);
  /** @type {string[]} */
  const logs = [];
  assert.equal(await commitTurn(dir, { handle: 'gem' }, p, workRoot, { log: (l) => logs.push(l) }), false);
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'nothing committed');
  assert.match(logs[0] ?? '', /a conflict is in progress there/);
});
