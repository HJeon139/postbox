// Replaces one transcript item without making thread.mjs, which is at its size ceiling, own replacement details.

/** Replaces an item and returns the id of its focused child. @param {HTMLElement | undefined} old @param {HTMLElement} next */
export function replaceTranscriptItem(old, next) {
  const focusedId = old?.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).id : '';
  old?.replaceWith(next);
  return focusedId;
}
