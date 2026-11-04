// Skipped items (#712): the transcript keeps every item mounted, and the browser skips the layout and paint of those off
// screen (`content-visibility: auto` on `.transcript.cv-skip > .item`, app/workbench.css), laying each out at an
// estimate until it draws. An item drawing for the first time changes size; the view (view-state.mjs) hears that
// through its ResizeObserver on the transcript, whose height changes with it, and holds the anchor. No item is observed
// on its own: no draw found a case the transcript's own observer misses, and V3 (tests/browser/view-skipped.spec.mjs)
// fails first if one turns up.

/** The class on a transcript whose items the browser may skip. */
export const SKIP_CLASS = 'cv-skip';

/**
 * Lets the browser skip the transcript's items off screen, where it can.
 * @param {HTMLElement} el  the transcript
 */
export function skipOffscreen(el) {
  if (typeof CSS === 'undefined' || !CSS.supports('content-visibility', 'auto')) return;
  el.classList.add(SKIP_CLASS);
}
