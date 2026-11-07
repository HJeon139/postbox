// Whether you did something while the smooth jump to the end ran (view-state.mjs, scrollToEnd). Where it stops is no
// guide: items it passes draw at their real sizes on the way, and where they’re shorter than their estimates, as the
// Mac’s fonts draw them, the page shortens under it and the scroll ends short of where it was aimed with nobody
// stopping it (view-skipped-smooth.spec.mjs). Only input that can scroll the page is you stopping it: a wheel turn, a
// touch, a press on the scrollbar, or a scroll key outside a field. A click into the composer, or typing there, isn’t.

const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** Whether the event’s target takes keys itself, so they don’t scroll the page. @param {EventTarget | null} target */
const takesKeys = (target) => target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);

/** Whether this input can scroll the page. @param {Event} e */
function canScroll(e) {
  if (e.type === 'pointerdown') return e.target === document.documentElement;
  if (e.type === 'keydown') return SCROLL_KEYS.has(/** @type {KeyboardEvent} */ (e).key) && !takesKeys(e.target);
  return true;
}

/**
 * Calls done once the smooth scroll ends (scrollend), saying whether any input of yours that can scroll came while it ran.
 * @param {(stoppedByYou: boolean) => void} done
 */
export function whenSmoothEnds(done) {
  let came = false;
  const heard = (/** @type {Event} */ e) => {
    if (canScroll(e)) came = true;
  };
  for (const type of INPUTS) addEventListener(type, heard, { capture: true, passive: true });
  const ended = () => {
    for (const type of INPUTS) removeEventListener(type, heard, { capture: true });
    done(came);
  };
  addEventListener('scrollend', ended, { once: true });
}
