// The transcript window’s structure for a screen reader (#866, W5). Each item is an article; the browser can count
// only what’s on the page, so each item the window mounts says its place among the items that draw (aria-posinset of
// aria-setsize, counted-items.mjs), and the transcript is busy while the range moves. Each update is
// O(mounted), bounded by the ceiling. Each function takes the window.

import { draws } from './counted-items.mjs';

/** The indexes of a list’s items that don’t draw, in order. @param {any[]} list */
export const skipsOf = (list) => list.flatMap((it, i) => (draws(it) ? [] : [i]));

/** How many of the sorted indexes are below i, which is also where i would go. @param {number[]} skips @param {number} i */
function before(skips, i) {
  let lo = 0;
  let hi = skips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (skips[mid] < i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A mounted item’s place and the count; an item that doesn’t draw has neither. @param {any} w the window @param {HTMLElement} node */
export function place(w, node) {
  const i = w.indexOf.get(node.dataset.key ?? '');
  if (i === undefined) return;
  const n = before(w.skips, i);
  if (w.skips[n] === i) {
    node.removeAttribute('aria-posinset');
    node.removeAttribute('aria-setsize');
    return;
  }
  node.setAttribute('aria-posinset', String(i + 1 - n));
  node.setAttribute('aria-setsize', String(w.total - w.skips.length));
}

/** Every mounted item’s place, islands too. @param {any} w the window */
export function placeAll(w) {
  for (const node of w.nodes.values()) place(w, node);
}

/** The range moved: every mounted item’s place again, and the transcript busy until the next frame. @param {any} w the window */
export function ranged(w) {
  placeAll(w);
  w.el.setAttribute('aria-busy', 'true');
  if (!w.busyFrame)
    w.busyFrame = requestAnimationFrame(() => {
      w.busyFrame = 0;
      w.el.removeAttribute('aria-busy');
    });
}

/** A new item at the end, already in the window’s list: the count changes for every item. @param {any} w the window @param {any} it */
export function counted(w, it) {
  if (!draws(it)) w.skips.push(w.total - 1);
  placeAll(w);
}

/**
 * An item drawn again, as `node`, or null when it’s off the page: if whether it draws changed (a reply replaced by
 * its replay), every place after it moves.
 * @param {any} w the window @param {any} it @param {HTMLElement | null} node
 */
export function redrawn(w, it, node) {
  const i = w.indexOf.get(it.id);
  if (i === undefined) return;
  const n = before(w.skips, i);
  const skipped = w.skips[n] === i;
  if (skipped === !draws(it)) {
    if (node) place(w, node);
    return;
  }
  if (skipped) w.skips.splice(n, 1);
  else w.skips.splice(n, 0, i);
  placeAll(w);
}
