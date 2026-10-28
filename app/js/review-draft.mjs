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
