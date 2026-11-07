// Where a transcript’s view is: its scroll box, how far it is from the end, and the message it reads at (the anchor).
// Moved from view-state.mjs, which is at its length limit (#866). The View type is view-state.mjs’s.

/** @typedef {import('./view-state.mjs').View} View */

export const box = (/** @type {View} */ v) => (v.inPanel ? v.el.parentElement : document.scrollingElement);
export const viewTop = (/** @type {View} */ v, /** @type {Element} */ s) => (v.inPanel ? s.getBoundingClientRect().top : 0);
export const gapOf = (/** @type {Element} */ s) => s.scrollHeight - s.scrollTop - s.clientHeight;
// At the bottom, give or take a pixel of rounding.
export const atEnd = (/** @type {Element} */ s) => gapOf(s) <= 2;
// The anchor is the message across the middle of the view, where you read, not the first one in view: that one
// usually starts above the view, and when a narrower column (the panel, a smaller window) rewraps it, everything
// under it moves. A wide font rewraps it where macOS’s doesn’t (#88, seen on Linux in #162).
// It runs on every scroll event, so it halves its way to the middle rather than reading every reply above it: in a
// room of 1,000 replies, a dozen rects instead of a thousand (#572).
const keyed = (/** @type {any} */ n) => n instanceof HTMLElement && !!n.dataset.key;
/** @param {View} v */
export function findAnchor(v) {
  const s = box(v);
  if (!s) return null;
  const top = viewTop(v, s);
  const mid = top + s.clientHeight / 2;
  const kids = v.el.children;
  let lo = 0;
  let hi = kids.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (kids[m].getBoundingClientRect().bottom > mid) hi = m;
    else lo = m + 1;
  }
  // Back to the reply before the first one across the middle (one that takes no room doesn’t count), then on as before.
  let from = 0;
  for (let i = lo - 1; i >= 0; i--) {
    const n = kids[i];
    if (!keyed(n)) continue;
    const r = n.getBoundingClientRect();
    if (!r.height) continue;
    from = i;
    if (r.bottom <= mid) break;
  }
  let last = null;
  for (let i = from; i < kids.length; i++) {
    const n = /** @type {HTMLElement} */ (kids[i]);
    if (!keyed(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.bottom <= top) continue;
    last = { key: /** @type {string} */ (n.dataset.key), at: r.top - top };
    if (r.bottom > mid) return last;
  }
  return last;
}
