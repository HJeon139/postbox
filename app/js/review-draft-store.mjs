// A review’s draft comments, kept over a reload (#1144), as the composer keeps its text under pb-draft-<threadId> and
// its files under pb-draft-files-<threadId> (#849). Each review block’s comments and verdict are kept in localStorage
// with the revision and the text they were written on, under pb-review-draft-<itemId>. A submit forgets them. Only
// comments the review could send are kept, at most MAX_COMMENTS, with that text up to LIMITS.longText, so a draft
// can’t fill the storage; a full one fails quietly.

import { LIMITS } from '/shared/limits.mjs';
import { commentErrors, MAX_COMMENTS, VERDICTS } from '/shared/review-comments.mjs';

const storageKey = (itemId) => `pb-review-draft-${itemId}`;
/** @type {Map<string, string>} each item’s last kept value, so a repaint that changes nothing writes nothing */
const last = new Map();

/** A comment as it’s sent, without the page’s own marks. @param {any} c */
const sendable = ({ moved: _m, gone: _g, ...c }) => c;
/** Whether a kept comment is one the review could send. @param {any} c */
const usable = (c) => !!c && typeof c === 'object' && commentErrors(sendable(c), 'c').length === 0;

/**
 * Keeps a review draft’s comments and verdict, or forgets the entry once it has no comments. O(its comments), and
 * nothing is written when the value is the one kept last.
 * @param {string} itemId @param {number} revision  the revision the comments are on @param {any} d  the draft
 */
export function keepReviewDraft(itemId, revision, d) {
  const comments = d.comments.filter(usable).slice(0, MAX_COMMENTS);
  // The text they were written on goes with them, so a reload follows them into a revision as an open page does.
  const on = typeof d.on === 'string' && d.on.length <= LIMITS.longText ? d.on : null;
  const value = comments.length ? JSON.stringify({ revision, verdict: d.verdict, comments, on }) : '';
  if (last.get(itemId) === value) return;
  last.set(itemId, value);
  try {
    if (value) localStorage.setItem(storageKey(itemId), value);
    else localStorage.removeItem(storageKey(itemId));
  } catch {}
}

/** Forgets a review’s kept draft, as a submit does. @param {string} itemId */
export function forgetReviewDraft(itemId) {
  last.set(itemId, '');
  try {
    localStorage.removeItem(storageKey(itemId));
  } catch {}
}

/**
 * A new draft with what was kept for the review put back, on the text they were written on: renderReview then
 * follows them from it into the text now, as it does a draft open during a revision (#123), so a reload reads the same
 * as a page left open. An entry without that text (an app review’s, or a malformed one) keeps its comments as they were.
 * @param {string} itemId @param {any} item  the block item @param {any} d  a new draft for its text
 */
export function restoreReviewDraft(itemId, item, d) {
  let kept;
  try {
    kept = JSON.parse(localStorage.getItem(storageKey(itemId)) ?? 'null');
  } catch {
    kept = null;
  }
  if (!kept || !Array.isArray(kept.comments) || item.answered) return d;
  const comments = kept.comments.filter(usable).slice(0, MAX_COMMENTS);
  const verdict = VERDICTS.includes(kept.verdict) ? kept.verdict : d.verdict;
  const on = typeof kept.on === 'string' && kept.on.length <= LIMITS.longText ? kept.on : d.on;
  return { ...d, verdict, comments, on };
}
