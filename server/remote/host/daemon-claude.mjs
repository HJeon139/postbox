// The daemon’s own check of the claude a remote Claude Code turn runs on (#1084). The laptop’s welcome is cached for
// the life of the connection, so the laptop sends every claude-code start with the minimum it needs (start.need), and
// the daemon decides from the claude it has at the start. It fails closed: REMOTE_CLAUDE_MIN is its own floor, with
// or without a need, and a need can only raise it. A cached version below the bar, or none, is read again once, so a
// `claude update` since the hello is found. A cached version at or above the bar isn’t read again: a claude replaced
// by an older one after the hello is spawned until the next hello reads it, which saves a --version per turn.

import { claudeProblem, REMOTE_CLAUDE_MIN } from '../../../shared/remote-claude.mjs';
import { olderThan } from '../../../shared/versions.mjs';
import { reprobe } from './daemon-login.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('../../../shared/remote-claude.mjs').ClaudeNeed} ClaudeNeed */
/** @typedef {import('./programs.mjs').HarnessFound} HarnessFound */

/**
 * The bar a claude-code start must clear: REMOTE_CLAUDE_MIN, or the start’s need when that’s higher, with its words.
 * @param {ClaudeNeed | undefined} need @returns {ClaudeNeed}
 */
export function claudeBar(need) {
  /** @type {ClaudeNeed} */
  const floor = { min: REMOTE_CLAUDE_MIN, why: 'remote' };
  // The one comparison the refusal itself uses, so the bar and the words can’t disagree.
  if (need && olderThan(floor.min, need.min) === true) return need;
  return floor;
}

/**
 * The claude this start runs on, judged in the laptop’s words: `problem` is why it can’t, or null, and `harness` the
 * entry that was judged, which the start spawns (#1084). A missing one has been looked for again already
 * (findHarness). One below the bar or of no known version has its --version read again, once, and what it said
 * replaces its entry in d.programs, so the next turn needn’t read it. If that still refuses and the host’s settings
 * don’t name the path, the programs are looked for again (reprobe, rate-limited), since the path the hello found may
 * be gone, or hold an old claude while a new one is elsewhere on the PATH.
 * @param {Daemon} d @param {HarnessFound | undefined} h  claude-code’s entry in d.programs @param {ClaudeNeed} [need]  start.need
 * @returns {Promise<{ problem: string | null, harness: HarnessFound | undefined }>}
 */
export async function claudeJudged(d, h, need) {
  const bar = claudeBar(need);
  const cached = claudeProblem(h, bar);
  if (!cached || !h?.path) return { problem: cached, harness: h };
  const loginPath = d.loginPath?.ok ? d.loginPath.entries : [];
  const read = await d.readVersion({ path: h.path, loginPath });
  const fresh = { ...h, version: 'version' in read ? read.version : null };
  if (d.programs) d.programs.harnesses = d.programs.harnesses.map((x) => (x === h ? fresh : x));
  const still = claudeProblem(fresh, bar);
  if (!still || d.settings?.claudePath) return { problem: still, harness: fresh };
  await reprobe(d);
  const again = d.programs?.harnesses.find((x) => x.name === 'claude-code');
  if (!again?.path || again.path === fresh.path) return { problem: still, harness: fresh };
  return { problem: claudeProblem(again, bar), harness: again };
}
