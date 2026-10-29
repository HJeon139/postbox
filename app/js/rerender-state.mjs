// Keeps native element state while one transcript item is replaced, outside thread.mjs at its size ceiling (#488).

/** A stable key for the raw block, activity list, or one expandable thought. @param {HTMLElement} details */
function detailsKey(details) {
  if (details.matches('details.raw')) return 'raw';
  if (details.matches('details.activity')) return 'activity';
  const step = details.dataset.stepId;
  return details.matches('details.step-text') && step ? `step:${step}` : null;
}

/** The open or closed state the person chose. @param {HTMLElement | undefined} root */
function detailsState(root) {
  const state = new Map();
  for (const details of root?.querySelectorAll('details.raw, details.activity, details.step-text') ?? []) {
    const key = detailsKey(/** @type {HTMLElement} */ (details));
    if (key) state.set(key, /** @type {HTMLDetailsElement} */ (details).open);
  }
  return state;
}

/** Replaces an item, restoring focus and matching activity details. @param {HTMLElement | undefined} old @param {HTMLElement} next */
export function replaceTranscriptItem(old, next) {
  const focusedId = old?.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).id : '';
  const state = detailsState(old);
  old?.replaceWith(next);
  for (const details of next.querySelectorAll('details.raw, details.activity, details.step-text')) {
    const key = detailsKey(/** @type {HTMLElement} */ (details));
    if (key && state.has(key)) /** @type {HTMLDetailsElement} */ (details).open = state.get(key) === true;
  }
  return focusedId;
}
