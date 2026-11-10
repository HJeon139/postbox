// A review’s draft comments, kept over a reload (#1144), as the composer keeps its text under pb-draft-<threadId> and
// its files under pb-draft-files-<threadId> (#849). Each review block’s comments and verdict are kept in localStorage
// with the revision they were written on, under pb-review-draft-<itemId>. A submit forgets them. Only comments the
// review could send are kept, at most MAX_COMMENTS, so a draft can’t fill the storage; a full one fails quietly.

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
  const value = comments.length ? JSON.stringify({ revision, verdict: d.verdict, comments }) : '';
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
 * A new draft with what was kept for the review put back. At the revision they were written on, the comments go back
 * on their places. At a later one, they follow their lines from previous when it’s the text they were on, as a draft
 * open during the revision does (#123); otherwise they stay where they were, marked moved.
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
  const b = item.block;
  const revision = item.revision ?? 1;
  if (kept.revision === revision || b.format === 'app') return { ...d, verdict, comments };
  const onPrevious = kept.revision === revision - 1 && typeof b.previous === 'string';
  if (onPrevious) return { ...d, verdict, comments, on: b.previous };
  return { ...d, verdict, comments: comments.map((c) => ({ ...c, moved: true })) };
}
