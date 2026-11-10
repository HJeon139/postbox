// The local answer in one review block, and which comment box is open. Kept outside the renderer at its size ceiling.

/** The first local answer for a review block. @param {string} content */
export const newReviewDraft = (content) => ({
  comments: [],
  composing: null,
  composingText: '',
  composingSelection: null,
  verdict: 'request_changes',
  view: 'diff',
  error: null,
  on: content,
});

/** Opens one empty comment box. @param {any} draft @param {any} key */
export function startComment(draft, key) {
  draft.composing = key;
  draft.composingText = '';
  draft.composingSelection = null;
}

/** Closes the open comment box and forgets its unfinished text. @param {any} draft */
export function stopComment(draft) {
  draft.composing = null;
  draft.composingText = '';
  draft.composingSelection = null;
}

/**
 * The person’s draft of a review, kept by item. Once they’ve submitted it, its comments are the block’s threads
 * (#1143), so one its submit hasn’t cleared yet, while the answer comes back, isn’t drawn beside them.
 * @param {any} item @param {string} content @param {(id: string, make: () => any) => any} draft  the blocks’ draft store
 */
export function reviewDraft(item, content, draft) {
  const d = draft(item.id, () => newReviewDraft(content));
  if (item.answer?.action === 'submit') d.comments = [];
  return d;
}
