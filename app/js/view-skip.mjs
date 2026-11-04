// Skipped items (#712): the transcript keeps every item mounted, and the browser skips the layout and paint of those off
// screen (`content-visibility: auto` on `.transcript.cv-skip > .item`, app/workbench.css), laying each out at an
// estimate until it draws. An item drawing for the first time changes size, and the view (view-state.mjs) holds the
// anchor: through its ResizeObserver on the transcript, and on each item's draw (DRAWN), since a draw inside the height
// the transcript holds while following changes nothing that observer sees (composer-grow.spec.mjs, #422).

/** The event a skipped item gets when it's drawn or skipped again; heard in capture, whether or not it bubbles. */
export const DRAWN = 'contentvisibilityautostatechange';

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
