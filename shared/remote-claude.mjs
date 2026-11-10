// Which claude a remote Claude Code turn runs on (C3, D2), and the words for one it can’t. The laptop says them from
// the welcome it cached at the hello, and the host’s daemon from the claude it finds at each start (#1084), so the
// person sees the same refusal from either side. A start carries the bar as `need`; the daemon never goes below
// REMOTE_CLAUDE_MIN, whatever it carries.

import { lookedText } from './remote-protocol-parts.mjs';
import { olderThan } from './versions.mjs';

/**
 * The oldest claude a remote turn runs on (C3): from 2.1.187 a stdio server’s calls have the idle window the shim’s
 * `timeout` and progress keep open (the docs’ env-vars page, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).
 */
export const REMOTE_CLAUDE_MIN = '2.1.187';
/** The oldest claude with `--permission-prompts none` (the CLI reference), for a host with denyPrompts on (D2). */
export const DENY_PROMPTS_MIN = '2.1.259';

/** start.need (#1084): why is one of NEED_REASONS (remote-protocol-constants.mjs). @typedef {{ min: string, why: 'remote' | 'denyPrompts' }} ClaudeNeed */

/** The minimum a start for these host settings carries. @param {{ denyPrompts?: boolean }} [settings] @returns {ClaudeNeed} */
export function claudeNeed(settings = {}) {
  if (settings.denyPrompts) return { min: DENY_PROMPTS_MIN, why: 'denyPrompts' };
  return { min: REMOTE_CLAUDE_MIN, why: 'remote' };
}

/**
 * Why this claude can’t run a remote turn, or null if it can: missing, a version that couldn’t be read, or older than
 * need.min. Each says what was found, and where.
 * @param {{ path?: string | null, version?: string | null, looked?: string[], fromLogin?: number } | undefined} h
 *   the harness entry a welcome lists for claude-code
 * @param {ClaudeNeed} need
 */
export function claudeProblem(h, need) {
  if (!h?.path) {
    const looked = h?.looked?.length ? ` It looked in ${lookedText(h)}.` : '';
    return `Claude Code isn’t installed on the host.${looked} Install it there, or set claudePath in the host’s settings.`;
  }
  const why = need.why === 'denyPrompts' ? ', which turning off permission prompts (denyPrompts) needs' : ', which remote turns need';
  const older = h.version ? olderThan(h.version, need.min) : null;
  if (older === null) {
    const said = h.version ? `“${h.version}”` : 'nothing';
    return `Postbox couldn’t tell the version of Claude Code at ${h.path} on the host (it said ${said}). It needs ${need.min} or later${why}.`;
  }
  if (older) return `Claude Code ${h.version} at ${h.path} on the host is older than ${need.min}${why}. Update it there with claude update.`;
  return null;
}

/**
 * Why a remote turn can’t start on the claude a welcome lists, or null if it can (claudeProblem, for these settings).
 * @param {any} welcome  the daemon’s latest welcome  @param {{ denyPrompts?: boolean }} [settings]  the host’s
 */
export function remoteClaudeProblem(welcome, settings = {}) {
  if (!welcome) return 'Postbox hasn’t heard from the host’s daemon yet, so it can’t tell which Claude Code is there.';
  const h = (Array.isArray(welcome.harnesses) ? welcome.harnesses : []).find((x) => x?.name === 'claude-code');
  return claudeProblem(h, claudeNeed(settings));
}
