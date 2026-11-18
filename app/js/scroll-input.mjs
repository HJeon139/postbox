// Input of yours that can scroll the page: a wheel turn, a touch, a press on the scrollbar, or a scroll key outside a
// field. A click into the composer, or typing there, isn’t. Moved from view-smooth.mjs.

export const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** Whether the event’s target takes keys itself, so they don’t scroll the page. @param {EventTarget | null} target */
const takesKeys = (target) => target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);

/** Whether this input can scroll the page. @param {Event} e */
export function canScroll(e) {
  if (e.type === 'pointerdown') return e.target === document.documentElement;
  if (e.type === 'keydown') return SCROLL_KEYS.has(/** @type {KeyboardEvent} */ (e).key) && !takesKeys(e.target);
  return true;
}
