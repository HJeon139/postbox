// Whether a host’s claude can run a remote turn, in one wording for the laptop and the host’s daemon (#1084). The
// laptop checks the daemon’s welcome; a daemon that says it checks (welcome.claudeChecks) checks again at the turn’s
// start, after looking for a claude installed since it connected, before it makes the turn’s folder.

import { olderThan } from './versions.mjs';

/**
 * The oldest claude a remote turn runs on (C3): from 2.1.187 a stdio server’s calls have the idle window the shim’s
 * `timeout` and progress keep open (the docs’ env-vars page, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).
 */
export const REMOTE_CLAUDE_MIN = '2.1.187';
/** The oldest claude with `--permission-prompts none` (the CLI reference), for a host with denyPrompts on (D2). */
export const DENY_PROMPTS_MIN = '2.1.259';

/**
 * Why a claude found at a path can’t run a remote turn, or null if it can: a version that couldn’t be read, or one older
 * than REMOTE_CLAUDE_MIN (or DENY_PROMPTS_MIN with denyPrompts). Each says what was found, and where.
 * @param {{ path: string, version?: string | null }} h @param {boolean} [denyPrompts]
 */
export function claudeVersionProblem(h, denyPrompts = false) {
  const need = denyPrompts ? DENY_PROMPTS_MIN : REMOTE_CLAUDE_MIN;
  const why = denyPrompts ? ', which turning off permission prompts (denyPrompts) needs' : ', which remote turns need';
  const older = h.version ? olderThan(h.version, need) : null;
  if (older === null)
    return `Postbox couldn’t tell the version of Claude Code at ${h.path} on the host (it said ${h.version ? `“${h.version}”` : 'nothing'}). It needs ${need} or later${why}.`;
  if (older) return `Claude Code ${h.version} at ${h.path} on the host is older than ${need}${why}. Update it there with claude update.`;
  return null;
}
