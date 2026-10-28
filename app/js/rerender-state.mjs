// Keeps native element state while one transcript item is replaced, outside thread.mjs at its size ceiling (#488).

/** A stable key for the activity list or one expandable thought. @param {HTMLElement} details */
function activityKey(details) {
  if (details.matches('details.activity')) return 'activity';
  const step = details.dataset.stepId;
  return details.matches('details.step-text') && step ? `step:${step}` : null;
}

/** The open or closed state the person chose. @param {HTMLElement | undefined} root */
function activityState(root) {
  const state = new Map();
  for (const details of root?.querySelectorAll('details.activity, details.step-text') ?? []) {
    const key = activityKey(/** @type {HTMLElement} */ (details));
    if (key) state.set(key, /** @type {HTMLDetailsElement} */ (details).open);
  }
  return state;
}

/** Replaces an item, restoring focus and matching activity details. @param {HTMLElement | undefined} old @param {HTMLElement} next */
export function replaceTranscriptItem(old, next) {
  const focusedId = old?.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).id : '';
  const state = activityState(old);
  old?.replaceWith(next);
  for (const details of next.querySelectorAll('details.activity, details.step-text')) {
    const key = activityKey(/** @type {HTMLElement} */ (details));
    if (key && state.has(key)) /** @type {HTMLDetailsElement} */ (details).open = state.get(key) === true;
  }
  return focusedId;
}
