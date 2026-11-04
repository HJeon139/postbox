// Skipped items (#712): the transcript keeps every item mounted, and the browser skips the layout and paint of those off
// screen (`content-visibility: auto` on `.transcript.cv-skip > .item`, app/workbench.css), laying each out at an
// estimate until it draws. An item drawing for the first time changes size, so the view (view-state.mjs) has to hear it
// before that frame paints, even when another item changes by as much the other way and the transcript keeps its
// height. Only a browser that says when an item starts and stops being skipped gets the rule.

/** The class on a transcript whose items the browser may skip. */
export const SKIP_CLASS = 'cv-skip';

/** Whether this browser fires contentvisibilityautostatechange, so the view can hear an item start to draw. */
const saysWhenDrawn = () => typeof HTMLElement === 'function' && 'oncontentvisibilityautostatechange' in HTMLElement.prototype;

/**
 * Lets the browser skip the transcript's items off screen, and has the view's size observer watch each item from when
 * it starts drawing until it's skipped again: its first real size then reaches follow() before the frame paints. Only
 * the drawn items are watched, so the observer's work is what's on screen, not the room.
 * @param {HTMLElement} el  the transcript
 * @param {ResizeObserver} sizes  the view's observer
 * @returns {() => void}  stops listening
 */
export function skipOffscreen(el, sizes) {
  if (!saysWhenDrawn()) return () => {};
  el.classList.add(SKIP_CLASS);
  /** @param {any} e  a ContentVisibilityAutoStateChangeEvent */
  const changed = (e) => {
    const item = e.target;
    if (item.parentElement !== el) return;
    if (!e.skipped) sizes.observe(item);
  };
  // In capture, so it's heard whether or not the event bubbles.
  el.addEventListener('contentvisibilityautostatechange', changed, true);
  return () => el.removeEventListener('contentvisibilityautostatechange', changed, true);
}
