// Where a transcript’s view is: its scroll box, how far it is from the end, and the message it reads at (the anchor),
// taken again when the window moves the page (heldBy).
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
/** The index of the first child whose bottom is below y: they’re in order, so it halves its way there. */
function firstBelow(/** @type {HTMLCollection} */ kids, /** @type {number} */ y) {
  let lo = 0;
  let hi = kids.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (kids[m].getBoundingClientRect().bottom > y) hi = m;
    else lo = m + 1;
  }
  return lo;
}
/** The reply across the middle of the view, or the last one in view above it. @param {View} v @param {Element} s */
function acrossMiddle(v, s) {
  const top = viewTop(v, s);
  const mid = top + s.clientHeight / 2;
  const kids = v.el.children;
  const lo = firstBelow(kids, mid);
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
    last = { n, at: r.top - top };
    if (r.bottom > mid) return last;
  }
  return last;
}
/** The first reply in view. @param {View} v @param {Element} s */
function firstInView(v, s) {
  const top = viewTop(v, s);
  const kids = v.el.children;
  for (let i = firstBelow(kids, top); i < kids.length; i++) {
    const n = /** @type {HTMLElement} */ (kids[i]);
    const r = n.getBoundingClientRect();
    if (keyed(n) && r.height) return { n, at: r.top - top };
  }
  return null;
}
/** Whether the browser is skipping an item’s content: laid out at an estimate it hasn’t drawn (view-skip.mjs). */
const skipped = (/** @type {HTMLElement} */ n) => !!n.firstElementChild && !n.firstElementChild.checkVisibility({ contentVisibilityAuto: true });
/**
 * The anchor: the reply across the middle. A scroll into skipped items (the browser’s own, as scrollIntoView, focus and
 * find do) lands where their estimates put things, and the reply across the middle is then skipped too, at a place the
 * page never showed: held, it carried what the scroll brought to the top off screen as a long reply above it drew,
 * 2,345 px in view-skipped-tab.spec.mjs (#1257). So then the anchor is the first reply in view, which the scroll put
 * there, and which what draws below it doesn’t move. It’s marked inView, and kept until you scroll again
 * (view-state.mjs, onScroll), so it isn’t traded for the middle once that has drawn.
 * @param {View} v
 */
export function findAnchor(v) {
  const s = box(v);
  if (!s) return null;
  const across = acrossMiddle(v, s);
  const inView = across && skipped(across.n) ? firstInView(v, s) : null;
  const found = inView ?? across;
  return found && { key: /** @type {string} */ (found.n.dataset.key), at: found.at, ...(inView ? { inView: true } : {}) };
}

/**
 * The window moved the page itself and held what you see in place (window.mjs): the move isn’t yours, so the next
 * scroll event doesn’t take it for one, and the anchor is taken where it left it. A jump’s target stays the anchor, as
 * in view-state.mjs’s onScroll. @param {View} v
 */
export function heldBy(v) {
  const s = box(v);
  if (!s) return;
  v.lastTop = s.scrollTop;
  if (v.stuck || v.pinned) return;
  v.anchor = findAnchor(v);
}
