// Where a transcript's view is (#508's design, "Browser"): its scroll box, how far from the end that is, and what
// you can see of it. Moved from view-state.mjs, unchanged.

/** @typedef {import('./view-state.mjs').View} View */

export const box = (/** @type {View} */ v) => (v.inPanel ? v.el.parentElement : document.scrollingElement);
export const viewTop = (/** @type {View} */ v, /** @type {Element} */ s) => (v.inPanel ? s.getBoundingClientRect().top : 0);
export const gapOf = (/** @type {Element} */ s) => s.scrollHeight - s.scrollTop - s.clientHeight;
// At the bottom, give or take a pixel of rounding.
export const atEnd = (/** @type {Element} */ s) => gapOf(s) <= 2;
/** @param {View} v */
function lastItem(v) {
  for (let n = v.el.lastElementChild; n; n = n.previousElementSibling) {
    if (n instanceof HTMLElement && n.dataset.key) return n;
  }
  return null;
}
/** @param {View} v @param {Element} s */
export const measure = (v, s) => ({
  end: s.scrollHeight,
  last: (lastItem(v)?.getBoundingClientRect().top ?? 0) - viewTop(v, s) + s.scrollTop,
  width: v.el.clientWidth,
});
/**
 * Where what you can see of the view starts and ends, in the page's y: the panel's scroll box, or the window below
 * the main pane's sticky top bar.
 * @param {View} v
 */
export function inSight(v) {
  const s = /** @type {Element} */ (box(v));
  if (v.inPanel) {
    const r = s.getBoundingClientRect();
    return { top: r.top, bottom: r.top + s.clientHeight };
  }
  const bar = document.querySelector('header.topbar')?.getBoundingClientRect().bottom ?? 0;
  return { top: Math.max(0, bar), bottom: s.clientHeight };
}
