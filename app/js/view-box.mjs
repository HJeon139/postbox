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
// (the shorter-items case in view-skipped-append.spec.mjs), and the Mac’s Firefox 18 px past what the page lost, with
// its height unchanged (#712a, view-skipped-append.spec.mjs’s first case).
const BROWSER_SLACK = 24;
/**
 * Whether a move up of up px is the browser’s: no more than what the page lost since the view last measured it, if
 * anything, and BROWSER_SLACK more. A wheel turn of yours moves further. A trackpad’s first small step up, landing in
 * the frame between a resize and its scroll event, can be taken for the browser’s: the view goes back to the end, and
 * the next step unsticks it in onScroll, so only that step is lost (#712a).
 * @param {View} v @param {Element} s @param {number} up
 */
export function browserMoved(v, s, up) {
  const lost = Math.max(0, v.held.end - s.scrollHeight);
  return up <= lost + BROWSER_SLACK;
}
