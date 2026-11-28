// #1709, from the integrator’s review of #1719 at b1891af6: an Antigravity agent in its own worktree no longer has the
// project’s folder to work in, so without Shell each read there asked on a card, a new wait on the person. It reads the
// project’s folder with no card now, read only: a write there still asks, and the repository’s .git stays outside the
// folders it may edit. And it’s told where it works: its worktree, its branch, the project’s folder, and that the person
// merges its branch (the person’s decision of 26 November 2026), so it names its branch when it commits.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { branchFor, turnFolders, worktreeNote, worktreesRootFor } from '../server/adapters/agent-worktree.mjs';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
import { AGY_RULES_LIMIT } from '../server/adapters/agy-plugin.mjs';
import { agyRules } from '../server/adapters/antigravity-cli.mjs';
import { agentGuide } from '../server/adapters/guide.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A data folder with an agent’s worktree under it, and a project folder beside it. */
function layout() {
  const root = tempDir('pb-wt-folders-');
  const workRoot = join(root, 'data', 'work');
  const project = { id: 'pr_x', folder: join(root, 'project') };
  const wt = join(worktreesRootFor(workRoot), 'pr_x', 'pe_a-abcd1234');
  for (const d of [project.folder, wt, join(root, 'home')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project.folder, 'notes.md'), 'the plan\n');
  return { root, workRoot, project, wt };
}

test('#1709 in its own worktree a turn may read the project’s folder, not work in it; in the shared folder, as before', () => {
  const { workRoot, project, wt } = layout();
  assert.deepEqual(turnFolders(wt, { project, readFiles: ['/att/a.png'], addDirs: ['/extra'] }, workRoot), {
    addDirs: ['/extra'],
    reads: ['/att/a.png', project.folder],
  });
  const shared = join(workRoot, 'pr_x');
  assert.deepEqual(turnFolders(shared, { project, readFiles: [] }, workRoot), { addDirs: [project.folder], reads: [] });
});

test('#1709 an agent in its own worktree reads a project file with no card, and a write there still asks', () => {
  const { root, workRoot, project, wt } = layout();
  const { addDirs, reads } = turnFolders(wt, { project }, workRoot);
  const decide = (/** @type {string} */ name, /** @type {any} */ args) =>
    decideAgyTool({ toolCall: { name, args } }, { mode: 'auto', folders: [wt, ...addDirs], reads, cwd: wt, home: join(root, 'home') }).decision;
  const file = join(project.folder, 'notes.md');
  assert.equal(decide('read_file', { Path: file }), 'allow');
  assert.notEqual(decide('write_to_file', { TargetFile: file, CodeContent: 'x' }), 'allow');
  // Without the project’s folder among its reads, the read asks, as it did at b1891af6.
  const before = decideAgyTool(
    { toolCall: { name: 'read_file', args: { Path: file } } },
    { mode: 'auto', folders: [wt], reads: [], cwd: wt, home: join(root, 'home') },
  ).decision;
  assert.notEqual(before, 'allow');
});

test('#1709 an agent in its own worktree is told its worktree, its branch and the project’s folder, and that the person merges', () => {
  const { workRoot, project, wt } = layout();
  const persona = { id: 'pe_a', handle: 'a' };
  // As git lays a worktree out: its .git names its record, whose HEAD names its branch.
  const record = join(workRoot, '..', 'told-record');
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, 'HEAD'), `ref: refs/heads/${branchFor(persona, project)}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${record}\n`);
  const note = worktreeNote(wt, persona, project, workRoot);
  assert.ok(note.startsWith('## Where you work'), note);
  for (const part of [
    'your own git worktree',
    branchFor(persona, project),
    project.folder,
    'which the person merges',
    'Postbox commits what you leave',
    'name your branch in your reply',
  ])
    assert.ok(note.includes(part), part);
  // It reaches the rules file agy reads, after the guide, and with the real guide, a note naming long folders, and
  // the hook’s notes, the whole file still fits agy’s 12,000 characters (tests/agy-rules-hook.test.mjs).
  // A project folder of 120 characters, and ids as long as Postbox makes them.
  const long = worktreeNote(wt, { id: 'pe_Aaaa1111', handle: 'researcher-two' }, { id: 'pr_AbCd1234', folder: `/${'p'.repeat(119)}` }, workRoot);
  const agent = { id: 'pe_Aaaa1111', handle: 'gemini', permissionMode: 'auto', tools: [] };
  const guide = agentGuide({ persona: agent, handles: ['gemini', 'critic'], toolRules: null, setup: false });
  const rules = agyRules({ persona: agent, guide, place: long, schemas: '/Users/someone/.gemini/antigravity-cli/mcp/postbox_postbox', hooked: true });
  assert.ok(rules.indexOf(long) > rules.indexOf(guide.slice(0, 40)));
  assert.ok(rules.length <= AGY_RULES_LIMIT, String(rules.length));
  // In the project’s shared folder there’s nothing to say.
  assert.equal(worktreeNote(join(workRoot, 'pr_x'), persona, project, workRoot), '');
});

test('#1709 the note can’t name a branch it doesn’t know: a reftable stub, or a name too long for the rules file', () => {
  const { workRoot, project, wt } = layout();
  const persona = { id: 'pe_a', handle: 'a' };
  const admin = join(workRoot, '..', 'record');
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${admin}\n`);
  // A repository in git’s reftable format: the record’s HEAD is a stub (git 2.52), detached or not, so no branch is
  // guessed, Postbox’s own included: the agent is told how to see it.
  writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/.invalid\n');
  const stub = worktreeNote(wt, persona, project, workRoot);
  assert.ok(stub.includes('on its own branch, which `git branch --show-current` names'));
  assert.ok(!stub.includes(branchFor(persona, project)));
  writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${'b'.repeat(300)}\n`);
  const note = worktreeNote(wt, persona, project, workRoot);
  assert.ok(note.includes('on its own branch, which `git branch --show-current` names'));
  assert.ok(!note.includes('b'.repeat(101)));
});

test('#1709 the note comes after the persona’s limits, so a long project path can’t push them out of agy’s rules', () => {
  const { workRoot, project, wt } = layout();
  const persona = { id: 'pe_a', handle: 'a', permissionMode: 'auto', tools: [] };
  const note = worktreeNote(wt, persona, { ...project, folder: `/${'p'.repeat(399)}` }, workRoot);
  const rules = agyRules({ persona, guide: 'GUIDE', place: note, hooked: true });
  const limits = rules.indexOf('## What you don’t do here');
  assert.ok(limits > 0, 'the persona has limits to keep');
  assert.ok(rules.indexOf('## Where you work') > limits, 'the note comes after them');
  assert.ok(rules.trimEnd().endsWith(note.trimEnd()), 'and last');
});

test('#1709 an agent in its own worktree runs read commands on the project’s folder with no card; writes and git there still ask', () => {
  const { root, workRoot, project, wt } = layout();
  const { addDirs, reads } = turnFolders(wt, { project }, workRoot);
  const run = (/** @type {string} */ CommandLine) =>
    decideAgyTool(
      { toolCall: { name: 'run_command', args: { CommandLine } } },
      { mode: 'auto', folders: [wt, ...addDirs], reads, cwd: wt, home: join(root, 'home') },
    ).decision;
  const notes = join(project.folder, 'notes.md');
  assert.equal(run(`cat ${notes}`), 'allow');
  assert.equal(run(`ls ${project.folder}`), 'allow');
  assert.equal(run(`grep plan ${notes}`), 'allow');
  assert.equal(run(`find ${project.folder} -name notes.md`), 'allow');
  assert.notEqual(run(`rm ${notes}`), 'allow', 'a write there still asks');
  assert.notEqual(run(`touch ${join(project.folder, 'x')}`), 'allow');
  assert.notEqual(run(`git diff ${notes}`), 'allow', 'git keeps to its own folders');
  // Without the project’s folder among its reads, a read command there asks, as at 716b1c34.
  const before = decideAgyTool(
    { toolCall: { name: 'run_command', args: { CommandLine: `cat ${notes}` } } },
    { mode: 'auto', folders: [wt], reads: [], cwd: wt, home: join(root, 'home') },
  ).decision;
  assert.notEqual(before, 'allow');
});
