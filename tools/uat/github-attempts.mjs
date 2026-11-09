// Which agents tried to reach GitHub, and the run’s guard refused them (#1072). Since #1061 every run’s agents have no
// gh login and no network git (tools/uat/github-guard.mjs), so an attempt fails, and only its transcript said so. This
// reads the agents’ recorded Bash calls (bashCalls) for the refusals the guard gives, in gh’s and git’s own words:
// gh’s answers to the token GitHub refuses, and git’s “transport … not allowed”. Whatever the exit code, since an
// agent often pipes a command to head or tail. It reads Claude Code’s streams only: Kiro’s, Codex’s and Antigravity’s
// aren’t read.

import { bashCalls } from './allowonce-triggers.mjs';

const NO_LOGIN = 'gh has no login (HTTP 401)';
/** What the guard answers, by what the call printed: gh 2.102.0’s wordings, as `gh api`, `gh pr list` and `gh auth status` print them. */
const REFUSALS = [
  { re: /gh: Bad credentials \(HTTP 401\)/, what: () => NO_LOGIN },
  { re: /HTTP 401: Bad credentials \(https:\/\/api\.github\.com\//, what: () => NO_LOGIN },
  { re: /The token in GH_TOKEN is invalid/, what: () => NO_LOGIN },
  { re: /^fatal: transport '(\w+)' not allowed/m, what: (m) => `git is refused ${m[1]}` },
];

/**
 * Each Bash call the guard refused, in the order the turns ran.
 * @param {any[]} streams  the agents’ recorded turns (readStreams) @returns {{ handle: string, command: string, what: string }[]}
 */
export function githubAttempts(streams) {
  const out = [];
  for (const c of bashCalls(streams)) {
    const text = c.result?.text ?? '';
    for (const r of REFUSALS) {
      const m = r.re.exec(text);
      if (!m) continue;
      out.push({ handle: c.handle, command: c.command, what: r.what(m) });
      break;
    }
  }
  return out;
}

/**
 * The report’s line for them, or nothing when no agent tried. A `- github: real` run has no guard, so nothing it
 * refused. @param {any[]} streams @param {{ github?: string }} [scenario] @returns {string[]}
 */
export function githubSection(streams, scenario = {}) {
  if (scenario.github === 'real') return [];
  const tried = githubAttempts(streams);
  if (!tried.length) return [];
  const each = tried.map((a) => `@${a.handle} \`${a.command.replaceAll('`', "'").slice(0, 120)}\` (${a.what})`);
  return [`**Agents tried to reach GitHub, and the run’s guard refused it:** ${each.join('; ')}.`, ''];
}
