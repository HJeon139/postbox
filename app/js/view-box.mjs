// What a transcript's view holds and shows (#508's design, "Browser"): the held measure of its end and newest
// message, and what you can see of it. Moved from view-state.mjs, unchanged; its scroll box is view-geometry.mjs's.

import { box, viewTop } from './view-geometry.mjs';

/** @typedef {import('./view-state.mjs').View} View */

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
