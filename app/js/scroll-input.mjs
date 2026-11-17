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

/** When input of yours that can scroll the page last came, by performance.now(); never yet, at first. */
let lastAt = Number.NEGATIVE_INFINITY;
for (const type of INPUTS)
  addEventListener(
    type,
    (e) => {
      if (canScroll(e)) lastAt = performance.now();
    },
    { capture: true, passive: true },
  );

/**
 * Whether input of yours that can scroll the page came within the last `ms`: a move of the view up with none is the
 * browser’s, such as a clamp to a page that shrank and grew again in one frame (#1464). @param {number} ms
 */
export const youScrolledWithin = (ms) => performance.now() - lastAt <= ms;
