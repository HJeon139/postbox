// Which agents tried to reach GitHub, and the run’s guard refused them (#1072). Since #1061 every run’s agents have no
// gh login and no network git (tools/uat/github-guard.mjs), so an attempt fails, and only its transcript said so. This
// reads the agents’ recorded Bash calls (bashCalls) for the two refusals the guard gives: gh’s 401, from the token
// GitHub refuses, and git’s “transport … not allowed”. It reads Claude Code’s streams only: Kiro’s, Codex’s and
// Antigravity’s aren’t read.

import { bashCalls } from './allowonce-triggers.mjs';

/** What the guard answers, by what the call printed. */
const REFUSALS = [
  { re: /HTTP 401|Bad credentials/, what: 'gh has no login (HTTP 401)' },
  { re: /transport '(\w+)' not allowed/, what: (m) => `git is refused ${m[1]}` },
];

/**
 * Each Bash call the guard refused, in the order the turns ran.
 * @param {any[]} streams  the agents’ recorded turns (readStreams) @returns {{ handle: string, command: string, what: string }[]}
 */
export function githubAttempts(streams) {
  const out = [];
  for (const c of bashCalls(streams)) {
    if (!c.result?.error) continue;
    for (const r of REFUSALS) {
      const m = r.re.exec(c.result.text);
      if (!m) continue;
      out.push({ handle: c.handle, command: c.command, what: typeof r.what === 'string' ? r.what : r.what(m) });
      break;
    }
  }
  return out;
}

/** The report’s line for them, or nothing when no agent tried. @param {any[]} streams @returns {string[]} */
export function githubSection(streams) {
  const tried = githubAttempts(streams);
  if (!tried.length) return [];
  const each = tried.map((a) => `@${a.handle} \`${a.command.replaceAll('`', "'").slice(0, 120)}\` (${a.what})`);
  return [`**Agents tried to reach GitHub, and the run’s guard refused it:** ${each.join('; ')}.`, ''];
}
