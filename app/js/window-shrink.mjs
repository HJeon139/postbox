// The window’s unmounting and its islands (#866, W2), split from window.mjs for size: each function takes the window.
// Past its ceiling, the range unmounts what’s furthest from the view; an item with focus stays mounted where it is,
// an island between spacers of its own, until focus leaves it.

import { h } from './dom.mjs';
import { saveDetails } from './rerender-state.mjs';
import { CEILING, MARGIN } from './window-limits.mjs';

/** Sets a spacer to stand in for items [a, b). @param {any} w the window @param {HTMLElement} spacer @param {number} a @param {number} b */
export function fill(w, spacer, a, b) {
  spacer.hidden = b <= a;
  spacer.style.height = `${w.spanOf(a, b)}px`;
}

/** The spacer that stands in for the items between island i and the one before it. @param {any} w the window @param {number} i */
export function gapBefore(w, i) {
  let gap = w.gaps.get(i);
  if (!gap) {
    gap = h('div.win-spacer', { 'aria-hidden': 'true' });
    w.gaps.set(i, gap);
  }
  return gap;
}

/**
 * Every spacer’s height, and its place around the islands: [gap][island]…[above][range][below][island][gap]….
 * Without `above`, only those below: changing one above the range would move what you read.
 * @param {any} w the window @param {boolean} [above]
 */
export function paintSpacers(w, above = true) {
  const islands = [...w.islands.keys()].sort((a, b) => a - b);
  if (above) paintAbove(w, islands);
  paintBelowRange(w, islands);
}

/** The spacers above the range, around its islands there. @param {any} w the window @param {number[]} islands */
function paintAbove(w, islands) {
  let start = 0;
  for (const i of islands.filter((i) => i < w.from)) {
    const gap = w.gapBefore(i);
    w.el.insertBefore(gap, /** @type {HTMLElement} */ (w.islands.get(i)));
    w.fill(gap, start, i);
    start = i + 1;
  }
  w.fill(w.above, start, w.from);
}

/** The spacers below the range, around its islands there. @param {any} w the window @param {number[]} islands */
function paintBelowRange(w, islands) {
  let after = /** @type {HTMLElement} */ (w.below);
  let from = w.to;
  for (const i of islands.filter((i) => i >= w.to)) {
    w.fill(after, from, i);
    const island = /** @type {HTMLElement} */ (w.islands.get(i));
    const gap = w.gapBefore(i);
    island.after(gap);
    after = gap;
    from = i + 1;
  }
  w.fill(after, from, w.total);
}

/** An island the range has reached: back in the range, as it is. @param {any} w the window @param {number} i */
export function rejoin(w, i) {
  const node = /** @type {HTMLElement} */ (w.islands.get(i));
  w.islands.delete(i);
  w.gaps.get(i)?.remove();
  w.gaps.delete(i);
  return node;
}

/**
 * Whether a node has to stay on the page: it holds focus. An app frame waiting on a send isn’t pinned yet: its send
 * still reaches the server, and only the app’s own reply is lost, the frame reloading from its saved state when it’s
 * mounted again (a gap the W2 hand-off names).
 * @param {HTMLElement} node
 */
export function pinned(node) {
  return node.contains(document.activeElement);
}

/** Takes item i off the page, keeping its open details; or, if it’s pinned, leaves it as an island. @param {any} w the window @param {number} i */
export function drop(w, i) {
  const id = w.entry.ids[i];
  const node = w.nodes.get(id);
  if (!node) return;
  if (w.pinned(node)) {
    w.islands.set(i, node);
    return;
  }
  w.saved.set(id, saveDetails(node));
  w.sizes.unobserve(node);
  node.remove();
  w.nodes.delete(id);
}

/** Islands no longer pinned leave the page. @param {any} w the window */
export function release(w) {
  let changed = false;
  for (const [i, node] of w.islands) {
    if (w.pinned(node)) continue;
    w.islands.delete(i);
    w.gaps.get(i)?.remove();
    w.gaps.delete(i);
    w.saved.set(w.entry.ids[i], saveDetails(node));
    w.sizes.unobserve(node);
    node.remove();
    w.nodes.delete(w.entry.ids[i]);
    changed = true;
  }
  if (changed) w.paintSpacers();
}

/**
 * @param {any} w
 * Past the ceiling, unmounts what’s furthest from the view, beyond the margin, by measured heights: from the top if
 * that’s further, holding what you see in place, else from the bottom.
 */
export function shrink(w) {
  if (w.size <= CEILING) return;
  const reach = w.viewH() * MARGIN;
  const first = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.from]));
  const last = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.to - 1]));
  const farAbove = -first.getBoundingClientRect().top - reach;
  const farBelow = last.getBoundingClientRect().bottom - w.viewH() - reach;
  if (farAbove > 0 && farAbove >= farBelow) w.dropTop(farAbove);
  else if (farBelow > 0) w.dropBottom(farBelow);
}

/** Unmounts from the top up to `px` of items, down to the ceiling. @param {any} w the window @param {number} px */
export function dropTop(w, px) {
  let n = 0;
  for (let cut = 0; w.size - n > CEILING && cut + w.heights.span(w.from + n, w.from + n + 1) <= px; n++)
    cut += w.heights.span(w.from + n, w.from + n + 1) + w.gap;
  if (!n) return;
  // Every item dropped was mounted, so measured: the spacer stands in for exactly their height, and nothing moves.
  // view-state holds the anchor through any change in size that’s left (holdAnchor).
  const keep = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.from + n]));
  for (let i = w.from; i < w.from + n; i++) w.drop(i);
  w.from += n;
  w.el.insertBefore(w.above, keep);
  w.paintSpacers();
}

/** Unmounts from the bottom up to `px` of items, down to the ceiling. @param {any} w the window @param {number} px */
export function dropBottom(w, px) {
  let n = 0;
  for (let cut = 0; w.size - n > CEILING && cut + w.heights.span(w.to - n - 1, w.to - n) <= px; n++) cut += w.heights.span(w.to - n - 1, w.to - n) + w.gap;
  if (!n) return;
  for (let i = w.to - n; i < w.to; i++) w.drop(i);
  w.to -= n;
  const last = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.to - 1]));
  last.after(w.below);
  w.paintSpacers();
}

/**
 * Moves the range to item i, for a jump to an item that isn’t on the page: everything mounted leaves (but what has
 * focus, which stays as an island), and the range opens around i, as a conversation opens around its anchor. The
 * jump then scrolls to it.
 * @param {any} w the window @param {number} i
 */
export function recenter(w, i) {
  for (let k = w.from; k < w.to; k++) w.drop(k);
  [w.from, w.to] = w.openRange(i);
  w.below.before(w.above);
  const below = [...w.islands.keys()].filter((k) => k >= w.to).sort((a, b) => b - a);
  for (const k of below) w.below.after(/** @type {HTMLElement} */ (w.islands.get(k)));
  w.mountRun(w.from, w.to, w.below);
  w.paintSpacers();
}
