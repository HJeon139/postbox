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
