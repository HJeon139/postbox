// The run’s project folder (the workspace), made before Postbox starts: a git repository of its own, and what the
// scenario’s `- seed:` plants in it (tools/uat/scenario.mjs).

import { spawnSync } from 'node:child_process';
import * as tm from './telemetry-run.mjs';

/**
 * Makes the workspace a repository and seeds it. Returns the canaries it planted, or null.
 * @param {{ seed: string|null }} scenario  @param {{ workspace: string }} paths  @param {string} dir  the run’s folder
 */
export function makeWorkspace(scenario, paths, dir) {
  // The workspace is a git repository of its own. It lies inside the Postbox checkout, so without one an agent’s
  // git add and commit would land in Postbox’s history; a workroom agent had to notice and make a nested repo.
  spawnSync('git', ['init', '-q', paths.workspace], { stdio: 'ignore' });
  const canaries = scenario.seed === 'canaries' ? tm.seedCanaries(paths.workspace, dir) : null;
  return canaries;
}
