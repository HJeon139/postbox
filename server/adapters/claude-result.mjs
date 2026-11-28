// How a finished Claude Code stream ended, read from its result line: why it failed, in words for the person,
// whether a fork failed for want of the message it was asked to start at, and whether the session is too large to go
// on. Moved from claude-stream.mjs.

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

// A session whose request is too large to cut down fails every turn that resumes it, Retry included (#674). Claude
// Code 2.1.318 says so, in its binary’s words for a request still over the byte limit without its media: “Reduce the
// input (large tool results or pasted content) or start a new session; this conversation cannot continue as is.” Read
// from the binary, not recorded: no turn has been recorded hitting it.
export const overSizeLimit = (/** @type {unknown} */ text) => /this conversation cannot continue as is/.test(String(text ?? ''));

/**
 * Whether a failed run says its session is too large to go on: in its result’s words whole (resultError clips them),
 * or in `also`, such as stderr. A turn that succeeded never counts, even if its reply quotes the words.
 */
export function sessionTooLarge(result, also = '') {
  if (result && !result.is_error) return false;
  return overSizeLimit([result?.result, ...(Array.isArray(result?.errors) ? result.errors : []), also].join('\n'));
}

/** What a session started over for being too large tells the agent, as Kiro’s SIZE_LIMIT_START_TEXT does (#544). */
export const SIZE_LIMIT_START_TEXT =
  'Your earlier conversation in this thread grew too large for Claude Code to send, so this is a fresh start. Read large files, images and tool results a few at a time.';
