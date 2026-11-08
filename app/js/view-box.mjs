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
// How far past what the page lost the browser’s move may go: Linux Firefox moved the view up 59 px as the page lost 39
// (the shorter-items case in view-skipped-append.spec.mjs), and the Mac’s Firefox 18 px (researcher’s trace).
const BROWSER_SLACK = 24;
/**
 * Whether a move up of up px is the browser’s: the page got shorter since the view last measured it, by no less than
 * the move less BROWSER_SLACK. A reply landing or an item growing as you scroll makes it taller (#341’s cases).
 * @param {View} v @param {Element} s @param {number} up
 */
export function browserMoved(v, s, up) {
  const lost = v.held.end - s.scrollHeight;
  return lost > 0 && up <= lost + BROWSER_SLACK;
}
