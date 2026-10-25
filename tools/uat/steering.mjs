// Keeps the Postbox checkout’s AGENTS.md (#315) out of a UAT run’s Claude Code sessions: its agents in the workspace,
// and the tester and verifier in the run’s folder. A run lies inside the checkout (uat-runs/), and Claude Code reads
// every AGENTS.md from a session’s folder up (code.claude.com/docs/en/memory, “AGENTS.md”). Those are the rules for
// developing Postbox, not for the scenario’s project or the person the tester plays.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The AGENTS.md files a Claude Code session in `folder` would load from the folders above it, each as the path and,
 * through links, the real path.
 * @param {string} folder
 */
export function steeringAbove(folder) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p; // not made yet: the path as given is the one to match
    }
  };
  const out = new Set();
  for (const start of new Set([folder, real(folder)])) {
    for (let dir = dirname(start); dir !== dirname(dir); dir = dirname(dir)) {
      for (const f of ['AGENTS.md', '.claude/AGENTS.md']) out.add(join(dir, f));
    }
  }
  return [...out];
}

/**
 * Has the project settings of `folder` exclude every AGENTS.md above it (claudeMdExcludes, which applies to AGENTS.md
 * too), beside any settings already there, so a session there starts as one in the person’s own project would. A git
 * repository there ignores the settings, so a scenario’s commits don’t carry them.
 * @param {string} folder
 */
export function hideSteeringAbove(folder) {
  const settings = join(folder, '.claude', 'settings.json');
  const had = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
  const claudeMdExcludes = [...new Set([...(had.claudeMdExcludes ?? []), ...steeringAbove(folder)])];
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, `${JSON.stringify({ ...had, claudeMdExcludes }, null, 2)}\n`);
  if (existsSync(join(folder, '.git', 'info'))) appendFileSync(join(folder, '.git', 'info', 'exclude'), '/.claude/settings.json\n');
}
