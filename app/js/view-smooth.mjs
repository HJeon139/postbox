// Whether you did something while the smooth jump to the end ran (view-state.mjs, scrollToEnd). Where it stops is no
// guide: items it passes draw at their real sizes on the way, and where they’re shorter than their estimates, as the
// Mac’s fonts draw them, the page shortens under it and the scroll ends short of where it was aimed with nobody
// stopping it (view-skipped-smooth.spec.mjs). Only input that can scroll the page is you stopping it: a wheel turn, a
// touch, a press on the scrollbar, or a scroll key outside a field. A click into the composer, or typing there, isn’t.
// What the view does when the smooth jump ends (smoothEnded), or when a jump to an item ends it (halt), is here too,
// moved from view-state.mjs at its size limit.

import { atEnd, box, findAnchor } from './view-geometry.mjs';
import { publish } from './view-publish.mjs';

/** @typedef {import('./view-state.mjs').View} View */

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

// The smooth jump to the end stopped. The items it passed drew at their real sizes on the way, so the end has moved:
// unless you did something meanwhile, go the rest of the way. If you did, a wheel turn or a drag ended it (Chromium
// drops a wheel turn's own scroll), and that's you reading where it stopped (view-smooth.mjs).
/** @param {View} v @param {boolean} stoppedByYou */
export function smoothEnded(v, stoppedByYou) {
  const s = box(v);
  if (!v.smoothing || v.dead || !s) return;
  v.smoothing = false;
  if (atEnd(s)) return;
  if (!stoppedByYou) s.scrollTop = s.scrollHeight;
  else {
    v.stuck = false;
    v.anchor = findAnchor(v);
    v.lastTop = s.scrollTop;
    publish(v);
  }
}
/**
 * A jump to an item ends the smooth jump to the end, and says whether one ran: smoothEnded would take the rest of the
 * way otherwise, since a jump isn’t input that can scroll (view-smooth.mjs). The jump’s own scroll ends the browser’s.
 * @param {View} v
 */
export function halt(v) {
  const ran = v.smoothing;
  v.smoothing = false;
  return ran;
}
