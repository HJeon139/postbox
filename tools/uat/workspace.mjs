// The run’s project folder (the workspace), made before Postbox starts: a git repository of its own, and what the
// scenario’s `- seed:` plants in it (tools/uat/scenario.mjs).

import { spawnSync } from 'node:child_process';
import { seedFakeEnv } from './allowonce-triggers.mjs';
import { seedFiles } from './fixtures.mjs';
import { seedGitRemote } from './git-remote.mjs';
import { hideSteeringAbove } from './steering.mjs';

/**
 * Makes the workspace a repository and seeds it.
 * @param {{ seed: string|null, files?: string|null }} scenario  @param {{ workspace: string }} paths  @param {string} dir  the run’s folder
 */
export function makeWorkspace(scenario, paths, dir) {
  // The workspace is a git repository of its own, so an agent’s git add and commit land there, and git never looks
  // above it for one. It once lay inside the Postbox checkout, where they landed in Postbox’s history; it’s in a temp
  // folder of its own now (runPaths, #885).
  spawnSync('git', ['init', '-q', paths.workspace], { stdio: 'ignore' });
  if (scenario.seed === 'fake-env') seedFakeEnv(paths.workspace);
  if (scenario.seed === 'git-remote') seedGitRemote(paths.workspace, dir);
  if (scenario.files) seedFiles(paths.workspace, scenario.files);
  // After the seeds, so the excludes join any settings one planted. The run’s folder is the tester’s.
  hideSteeringAbove(paths.workspace);
  hideSteeringAbove(dir);
}
