// The run’s project folder (the workspace), made before Postbox starts: a git repository of its own, and what the
// scenario’s `- seed:` plants in it (tools/uat/scenario.mjs).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedFakeEnv } from './allowonce-triggers.mjs';
import * as tm from './telemetry-run.mjs';

/**
 * Makes the workspace a repository and seeds it. Returns the canaries it planted, or null.
 * @param {{ seed: string|null }} scenario  @param {{ workspace: string }} paths  @param {string} dir  the run’s folder
 */
export function makeWorkspace(scenario, paths, dir) {
  // The workspace is a git repository of its own. It lies inside the Postbox checkout, so without one an agent’s
  // git add and commit would land in Postbox’s history; a workroom agent had to notice and make a nested repo.
  spawnSync('git', ['init', '-q', paths.workspace], { stdio: 'ignore' });
  hideSteeringAbove(paths.workspace);
  const canaries = scenario.seed === 'canaries' ? tm.seedCanaries(paths.workspace, dir) : null;
  if (scenario.seed === 'fake-env') seedFakeEnv(paths.workspace);
  return canaries;
}

/**
 * The AGENTS.md files a Claude Code agent in the workspace would load from the folders above it: Claude Code reads every
 * one from its folder up (code.claude.com/docs/en/memory, “AGENTS.md”), and the workspace lies inside the Postbox
 * checkout, whose AGENTS.md are the rules for developing Postbox (#315). Each as the path and, through links, the real path.
 * @param {string} workspace
 */
export function steeringAbove(workspace) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p; // not made yet: the path as given is the one to match
    }
  };
  const out = new Set();
  for (const start of new Set([workspace, real(workspace)])) {
    for (let dir = dirname(start); dir !== dirname(dir); dir = dirname(dir)) {
      for (const f of ['AGENTS.md', '.claude/AGENTS.md']) out.add(join(dir, f));
    }
  }
  return [...out];
}

/**
 * Keeps a run’s Claude Code agents from reading the Postbox checkout’s AGENTS.md, so they start as an agent in the
 * person’s own project would: the workspace’s project settings exclude every one above it (claudeMdExcludes, which
 * applies to AGENTS.md too), kept beside any settings a scenario seeded, and its git ignores the settings, so a
 * scenario’s commits don’t carry them.
 * @param {string} workspace
 */
export function hideSteeringAbove(workspace) {
  const settings = join(workspace, '.claude', 'settings.json');
  const had = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
  const claudeMdExcludes = [...new Set([...(had.claudeMdExcludes ?? []), ...steeringAbove(workspace)])];
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, `${JSON.stringify({ ...had, claudeMdExcludes }, null, 2)}\n`);
  if (existsSync(join(workspace, '.git', 'info'))) appendFileSync(join(workspace, '.git', 'info', 'exclude'), '/.claude/settings.json\n');
}
