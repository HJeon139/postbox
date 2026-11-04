// The anchor of a transcript’s view: the message across the middle of the view, and how far down the view it starts
// (view-state.mjs). Moved from view-state.mjs unchanged, to keep that file under its size.

const keyed = (/** @type {any} */ n) => n instanceof HTMLElement && !!n.dataset.key;
/**
 * The anchor in transcript el, scrolled by s, whose view starts at top (the page’s y).
 * @param {HTMLElement} el @param {Element} s @param {number} top
 * @returns {{ key: string, at: number } | null}
 */
export function anchorIn(el, s, top) {
  const mid = top + s.clientHeight / 2;
  const kids = el.children;
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
