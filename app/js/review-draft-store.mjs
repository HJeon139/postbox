// A review’s draft comments, kept over a reload (#1144), as the composer keeps its text under pb-draft-<threadId> and
// its files under pb-draft-files-<threadId> (#849). Each review block’s comments and verdict are kept in localStorage
// with the revision and the text they were written on, under pb-review-draft-<itemId>. A submit forgets them. Only
// comments the review could send are kept, at most MAX_COMMENTS, with that text up to LIMITS.longText, and at most
// KEPT_DRAFTS reviews, the oldest dropped first; a review found answered loses its entry. A full storage fails quietly.

import { LIMITS } from '/shared/limits.mjs';
import { commentErrors, MAX_COMMENTS, VERDICTS } from '/shared/review-comments.mjs';

const storageKey = (itemId) => `pb-review-draft-${itemId}`;
/** The most review drafts kept: each can hold a review’s whole text, so a cap keeps them from filling the storage. */
export const KEPT_DRAFTS = 20;
/** The kept drafts’ item ids, oldest first, so the oldest goes when there are too many. */
const INDEX_KEY = 'pb-review-drafts';
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
    // The oldest goes first, so a storage full at KEPT_DRAFTS has room for this one.
    reindex(itemId, !!value);
    if (value) localStorage.setItem(storageKey(itemId), value);
    else localStorage.removeItem(storageKey(itemId));
  } catch {}
}

/**
 * The index with itemId last, if it’s kept, or left out; past KEPT_DRAFTS, the oldest entries are removed, never
 * itemId’s. O(KEPT_DRAFTS). @param {string} itemId @param {boolean} keeps
 */
function reindex(itemId, keeps) {
  let ids = [];
  try {
    const read = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
    if (Array.isArray(read)) ids = read.filter((x) => typeof x === 'string' && x !== itemId);
  } catch {}
  if (keeps) ids.push(itemId);
  while (ids.length > KEPT_DRAFTS) {
    const oldest = /** @type {string} */ (ids.shift());
    localStorage.removeItem(storageKey(oldest));
    last.delete(oldest);
  }
  localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
}

/** Forgets a review’s kept draft, as a submit does. @param {string} itemId */
export function forgetReviewDraft(itemId) {
  last.set(itemId, '');
  try {
    localStorage.removeItem(storageKey(itemId));
    reindex(itemId, false);
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
  // Answered here or elsewhere, dismissed or withdrawn: nothing to come back to, so the entry goes too.
  if (item.answered) {
    if (kept) forgetReviewDraft(itemId);
    return d;
  }
  if (!kept || !Array.isArray(kept.comments)) return d;
  const comments = kept.comments.filter(usable).slice(0, MAX_COMMENTS);
  const verdict = VERDICTS.includes(kept.verdict) ? kept.verdict : d.verdict;
  const on = typeof kept.on === 'string' && kept.on.length <= LIMITS.longText ? kept.on : d.on;
  return { ...d, verdict, comments, on };
}
