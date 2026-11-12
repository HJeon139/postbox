// The run’s project folder (the workspace), made before Postbox starts: a git repository of its own, and what the
// scenario’s `- seed:` plants in it (tools/uat/scenario.mjs).

import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { seedFakeEnv } from './allowonce-triggers.mjs';
import { seedFiles } from './fixtures.mjs';
import { seedGitRemote } from './git-remote.mjs';
import { hideSteeringAbove } from './steering.mjs';

/**
 * Makes the workspace a repository and seeds it.
 * @param {{ seed: string|null, files?: string|null }} scenario  @param {{ workspace: string }} paths  @param {string} dir  the run’s folder
 */
export function makeWorkspace(scenario, paths, dir) {
  // The workspace is a git repository of its own. It lies inside the Postbox checkout, so without one an agent’s
  // git add and commit would land in Postbox’s history; a workroom agent had to notice and make a nested repo.
  spawnSync('git', ['init', '-q', paths.workspace], { stdio: 'ignore' });
  if (scenario.seed === 'fake-env') seedFakeEnv(paths.workspace);
  if (scenario.seed === 'git-remote') seedGitRemote(paths.workspace, dir);
  if (scenario.files) seedFiles(paths.workspace, scenario.files);
  if (scenario.seed?.startsWith('dir:')) seedDir(paths.workspace, scenario.seed.slice(4));
  // After the seeds, so the excludes join any settings one planted. The run’s folder is the tester’s.
  hideSteeringAbove(paths.workspace);
  hideSteeringAbove(dir);
}

/**
 * `- seed: dir:<path>` (the Loop study kit): the folder's contents, dotfiles included, become the project folder. A path
 * that isn't a folder stops the run rather than starting it with an empty workspace.
 * @param {string} workspace @param {string} src
 */
export function seedDir(workspace, src) {
  let dir = false;
  try {
    dir = statSync(src).isDirectory();
  } catch {}
  if (!dir) throw new Error(`Couldn’t seed the workspace from ${src}: it isn’t a folder.`);
  // Symlinks are copied as written (critic 11/12): by default cpSync makes a relative one absolute, under the seed, and
  // writes through it would change the shared seed. A link that already resolves into the seed folder is refused.
  const root = realpathSync(src);
  for (const link of linksIn(src)) {
    const target = resolve(dirname(link), readlinkSync(link));
    if (!isAbsolute(readlinkSync(link)) || !(target === root || target.startsWith(root + sep))) continue;
    throw new Error(`Couldn’t seed the workspace from ${src}: ${link} points back into the seed folder.`);
  }
  cpSync(src, workspace, { recursive: true, verbatimSymlinks: true });
}

/** Every symlink under a folder, without following any. @param {string} dir @returns {string[]} */
function linksIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isSymbolicLink() ? [p] : e.isDirectory() ? linksIn(p) : [];
  });
}
