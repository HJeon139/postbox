// How a finished Claude Code stream ended, read from its result line: why it failed, in words for the person, and
// whether a fork failed for want of the message it was asked to start at. Moved from claude-stream.mjs.

import { clip } from '../harness-tools.mjs';

/** Why a finished stream failed, in words for the person, or null if it didn’t. */
export function resultError(result) {
  if (!result) return 'Claude Code ended without finishing the turn.';
  if (!result.is_error && result.subtype === 'success') return null;
  // The reasons Claude Code gives (result.errors), bounded: a failure that only says “hit an error” can’t be fixed.
  const reasons = (Array.isArray(result.errors) ? result.errors : [])
    .filter((e) => typeof e === 'string' && e.trim())
    .slice(0, 3)
    .map((e) => clip(e, 300));
  const why = reasons.length ? `: ${reasons.join('; ')}` : '.';
  if (result.subtype === 'error_max_turns') return 'The agent hit its turn limit before finishing.';
  if (result.subtype === 'error_during_execution') return `Claude Code hit an error while running the turn${why}`;
  const text = typeof result.result === 'string' && result.result.trim() ? result.result.trim() : null;
  return text ? clip(text, 400) : `Claude Code reported a failure (${result.subtype ?? 'unknown'})${why}`;
}

/**
 * Whether a fork failed because Claude Code can’t find the message it was asked to start at
 * (--resume-session-at): that message is no longer on the session’s chain.
 * `also` is more text to look in, such as stderr. A turn that succeeded never counts,
 * whatever stderr says: its reply stands.
 */
export function forkPointMissing(result, also = '') {
  if (result && !result.is_error) return false;
  const said = [...(Array.isArray(result?.errors) ? result.errors : []), also].map(String).join('\n');
  return /No message found with message\.uuid/.test(said);
}
