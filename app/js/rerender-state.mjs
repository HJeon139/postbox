// Keeps native element state while the transcript is drawn again, outside thread.mjs at its size ceiling (#488):
// which details are open, and where the keyboard and the caret were (#739).

import { buildSteps } from './activity-paint.mjs';

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

/**
 * Replaces an item, restoring matching activity details. The view takes its note while the page has the new item’s
 * height (#903): a finished reply drawn again can be shorter, and the page can grow back before the frame.
 * @param {HTMLElement | undefined} old @param {HTMLElement} next @param {{ redrawn: () => void }} [view]
 */
export function replaceTranscriptItem(old, next, view) {
  const state = detailsState(old);
  old?.replaceWith(next);
  if (old) view?.redrawn();
  // An activity list opened again is built first, so the thoughts it held expanded are there to expand (#1028).
  if (state.get('activity') === true) for (const list of next.querySelectorAll('details.activity')) buildSteps(/** @type {HTMLElement} */ (list));
  for (const details of next.querySelectorAll('details.raw, details.activity, details.step-text')) {
    const key = detailsKey(/** @type {HTMLElement} */ (details));
    if (key && state.has(key)) /** @type {HTMLDetailsElement} */ (details).open = state.get(key) === true;
  }
}

/**
 * Notes what has focus, and its caret, before the transcript is drawn again; the function it returns puts both back
 * on the element with the same id, if the redraw took them (#739). Unlike ui.mjs’s keepFocus, which falls back to the
 * control in the same place for a sheet, a transcript matches by id only: it holds thousands of controls, and the one
 * in the same place is another message. Focus the redraw didn’t take stays where it is.
 */
export function holdFocus() {
  const was = /** @type {HTMLInputElement | null} */ (document.activeElement);
  const id = was?.id;
  const caret = typeof was?.selectionStart === 'number' ? [was.selectionStart, was.selectionEnd, was.selectionDirection] : null;
  return () => {
    const next = id ? /** @type {HTMLInputElement | null} */ (document.getElementById(id)) : null;
    if (!next) return;
    next.focus({ preventScroll: true });
    if (caret && typeof next.selectionStart === 'number') next.setSelectionRange(caret[0], caret[1], caret[2] ?? undefined);
  };
}

/** The open details an item holds, to keep while it’s off the page (the window, #866). @param {HTMLElement} node */
export const saveDetails = (node) => detailsState(node);

/** Opens and closes an item’s details as they were when it left the page. @param {HTMLElement} node @param {Map<string, boolean> | undefined} state */
export function restoreDetails(node, state) {
  if (!state?.size) return;
  for (const details of node.querySelectorAll('details.raw, details.activity, details.step-text')) {
    const key = detailsKey(/** @type {HTMLElement} */ (details));
    if (key && state.has(key)) /** @type {HTMLDetailsElement} */ (details).open = state.get(key) === true;
  }
}
