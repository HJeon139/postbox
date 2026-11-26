// The local answer in one review block, and which comment box is open. Kept outside the renderer at its size ceiling.

import { followLines } from '/shared/review-diff.mjs';
import { restoreReviewDraft } from './review-draft-store.mjs';

/** The first local answer for a review block. @param {string} content */
export const newReviewDraft = (content) => ({
  comments: [],
  composing: null,
  composingText: '',
  composingSelection: null,
  // The draft comment open for editing, by its place in comments, and its unsaved text (#858).
  editing: null,
  editingText: '',
  editingSelection: null,
  // New comments’ unfinished text, set aside by Edit, one per place, and whether a box or Edit was just opened.
  parked: [],
  composeFocus: false,
  editFocus: false,
  // Which box last had focus, kept while it’s rebuilt, so a repaint gives focus back only to the box that had it.
  focusedBox: null,
  verdict: 'request_changes',
  view: 'diff',
  error: null,
  on: content,
});

/**
 * Opens one comment box: empty, or with what was typed there before Edit closed it (parkComment). @param {any} draft
 * @param {any} key
 */
export function startComment(draft, key) {
  // One box at a time: an edit open elsewhere keeps what was typed in it.
  saveEdit(draft);
  // Only this place’s text comes back; text set aside for another place waits for its own.
  const at = draft.parked.findIndex((p) => samePlace(p.key, key));
  const parked = at < 0 ? null : draft.parked[at];
  if (parked) draft.parked = draft.parked.filter((_p, i) => i !== at);
  draft.composing = key;
  draft.composingText = parked ? parked.text : '';
  draft.composingSelection = null;
  draft.composeFocus = true;
}

/** Whether two comment boxes are on the same line, part or selection. @param {any} a @param {any} b */
const samePlace = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Closes a new comment’s box for an edit (#858), setting aside what was typed in it: reopening the same line, part or
 * selection brings it back, whatever was opened in between. @param {any} draft
 */
export function parkComment(draft) {
  const key = draft.composing;
  if (key !== null && draft.composingText.trim()) draft.parked = [...draft.parked.filter((p) => !samePlace(p.key, key)), { key, text: draft.composingText }];
  stopComment(draft);
}

/** Closes the open comment box and forgets its unfinished text. @param {any} draft */
export function stopComment(draft) {
  draft.composing = null;
  draft.composingText = '';
  draft.composingSelection = null;
}

/**
 * The person’s draft of a review, kept by item, and started from what was kept over a reload (#1144). Once they’ve
 * submitted it, its comments are the block’s threads (#1143). Until the answer comes back the draft may still hold
 * them, so it’s emptied then, and they aren’t drawn twice.
 * @param {any} item @param {string} content @param {(id: string, make: () => any) => any} draft  the blocks’ draft store
 */
export function reviewDraft(item, content, draft) {
  const d = draft(item.id, () => restoreReviewDraft(item.id, item, newReviewDraft(content)));
  if (item.answer?.action === 'submit') d.comments = [];
  else dropSent(d, item.priorAnswer);
  return d;
}

/**
 * Closes the draft comment open for editing, keeping what was typed in it when it isn’t blank (#858), so opening
 * another box or submitting never drops it. @param {any} draft
 */
export function saveEdit(draft) {
  const at = draft.editing;
  const text = typeof draft.editingText === 'string' ? draft.editingText.trim() : '';
  if (typeof at === 'number' && text && draft.comments[at]) draft.comments = draft.comments.map((c, i) => (i === at ? { ...c, text } : c));
  draft.editing = null;
  draft.editingText = '';
  draft.editingSelection = null;
}

/** A comment box’s place, a line or a selection, followed into the revised text as its comments are (#123). */
function follow(key, from, to) {
  const [c] = followLines([typeof key === 'number' ? { line: key } : key], from, to);
  return typeof c.col === 'number' ? c : (c.line ?? null);
}

/**
 * The open comment box, and the text set aside for one (#858), go with their line or selection when the agent revises
 * the text. An app’s part (a string) stays. @param {any} draft @param {string} from @param {string} to
 */
export function followOpen(draft, from, to) {
  if (draft.composing !== null && typeof draft.composing !== 'string') draft.composing = follow(draft.composing, from, to);
  draft.parked = draft.parked.map((p) => (typeof p.key === 'string' ? p : { ...p, key: follow(p.key, from, to) }));
}

/**
 * The comments an answer sends (#518), marked with the revision it answered as it goes. A spread copies the mark, as
 * followLines copies a comment, and JSON leaves it out, so it reaches neither the answer nor what a reload keeps.
 */
const SENT = Symbol('sent');

/** Marks the comments an answer sends for a revision. @param {any} d  the review’s draft, if it has one @param {number} revision */
export function markSent(d, revision) {
  for (const c of Array.isArray(d?.comments) ? d.comments : []) c[SENT] = revision;
}

/** An answer that didn’t go: its comments are unsent drafts again. @param {any} d */
export function unmarkSent(d) {
  for (const c of Array.isArray(d?.comments) ? d.comments : []) delete c[SENT];
}

/**
 * A newer revision drawn after an answer that landed (its `priorAnswer`, which the page may never have drawn answered:
 * a page elsewhere, a resync): the comments that answer sent are the block’s threads now, so they leave the draft here,
 * where the block is drawn, and the person sees the draft they send (#518). Only an answer that landed takes them: one
 * the server refused as stale left them the person’s. What they started on the newer revision stays, and so does the
 * verdict on screen. An edit open is saved first, since it’s kept by its place in the comments.
 * @param {any} d @param {{ action: string, revision: number } | undefined} landed
 */
function dropSent(d, landed) {
  if (landed?.action !== 'submit') return;
  const taken = (/** @type {any} */ c) => c[SENT] !== undefined && c[SENT] <= landed.revision;
  if (!d.comments.some(taken)) return;
  saveEdit(d);
  d.comments = d.comments.filter((/** @type {any} */ c) => !taken(c));
}
