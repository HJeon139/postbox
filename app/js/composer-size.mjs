// The composer’s box grows with its draft, up to 200 px, then scrolls. Moved out of mountComposer in
// app/js/thread.mjs, which is at its length ceiling.

/** Sizes a draft’s box to its lines. @param {HTMLTextAreaElement} ta */
export function fitDraft(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
}
