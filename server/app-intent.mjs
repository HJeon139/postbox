// An app version’s intent (#995): what it should leave the reader with, as the agent said it, trimmed and cut for
// storage, and the receipt’s note when it runs past its word limit. Moved from server/apps.mjs.

import { INTENT_CHARS, LIMITS } from '../shared/limits.mjs';
import { wordCount } from '../shared/text.mjs';
import { cutText } from '../shared/text-parts.mjs';

/**
 * What a version should leave the reader with, as the agent said it (#995), or '' when it said nothing: a missing or
 * malformed intent never refuses an app, and a very long one is cut for storage.
 */
export const intentOf = (v) => (typeof v === 'string' ? cutText(v.trim(), INTENT_CHARS) : '');

/**
 * The receipt’s note on an intent past its word limit, or ''. It’s flagged, not refused: the app is the work, and the
 * agent can say it shorter with update_app. @param {unknown} v
 */
function intentNote(v) {
  const n = typeof v === 'string' ? wordCount(v) : 0; // before the storage cut, so a very long one reports its length
  return n > LIMITS.appIntentWords ? ` Its intent has ${n} words: say it in at most ${LIMITS.appIntentWords} with update_app.` : '';
}

/**
 * An app block as show_block takes it, with its intent trimmed and cut as show_app’s is, or dropped when it isn’t
 * text, so the catalog never refuses an app for its intent. @param {any} block
 */
export function withAppIntent(block) {
  if (block?.type !== 'app' || !Object.hasOwn(block, 'intent')) return block;
  const { intent, ...rest } = block;
  return intentOf(intent) ? { ...rest, intent: intentOf(intent) } : rest;
}

/** A receipt with the intent’s note, when there is one. @param {any} r @param {unknown} intent */
export const withIntentNote = (r, intent) => (r.ok && intentNote(intent) ? { ...r, message: r.message + intentNote(intent) } : r);
