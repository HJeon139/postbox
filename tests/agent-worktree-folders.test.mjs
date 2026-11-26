// #1709, from the integrator’s review of #1719 at b1891af6: an Antigravity agent in its own worktree no longer has the
// project’s folder to work in, so without Shell each read there asked on a card, a new wait on the person. It reads the
// project’s folder with no card now, read only: a write there still asks, and the repository’s .git stays outside the
// folders it may edit.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { turnFolders, worktreesRootFor } from '../server/adapters/agent-worktree.mjs';
import { decideAgyTool } from '../server/adapters/agy-hook.mjs';
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
