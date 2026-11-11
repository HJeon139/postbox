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
 * How far the range is past its limits: by items, past the ceiling, and by elements, past the budget it opened with
 * (window-cost.mjs).
 * @param {any} w the window @returns {{ items: number, elements: number }}
 */
function excess(w) {
  let cost = 0;
  for (let i = w.from; i < w.to; i++) cost += w.costOf(i);
  return { items: w.size - CEILING, elements: cost - w.budget };
}

/**
 * @param {any} w
 * Past the ceiling of items or the budget of elements, unmounts what’s furthest from the view, beyond the margin, by
 * measured heights: from the top if that’s further, holding what you see in place, else from the bottom. Past the
 * budget alone, only what’s beyond twice the margin: a growth mounts about a margin past where it was asked for, and
 * dropping that again had the next scroll mount it again, over and over, past an item that alone is near the budget.
 */
export function shrink(w) {
  const over = excess(w);
  if (over.items <= 0 && over.elements <= 0) return;
  const reach = w.viewH() * (over.items > 0 ? MARGIN : 2 * MARGIN);
  const first = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.from]));
  const last = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.to - 1]));
  const farAbove = -first.getBoundingClientRect().top - reach;
  const farBelow = last.getBoundingClientRect().bottom - w.viewH() - reach;
  if (farAbove > 0 && farAbove >= farBelow) w.dropTop(farAbove, over);
  else if (farBelow > 0) w.dropBottom(farBelow, over);
}

/**
 * How many items to unmount from one end, by step from `edge`: until the range is back within both limits, or the next
 * would cut past `px` of items. @param {any} w the window @param {number} edge @param {number} step @param {number} px
 * @param {{ items: number, elements: number }} over
 */
function dropCount(w, edge, step, px, over) {
  let n = 0;
  let freed = 0;
  for (let cut = 0; n < over.items || freed < over.elements; n++) {
    const i = edge + n * step;
    const h = w.heights.span(i, i + 1);
    if (n >= w.size - 1 || cut + h > px) break;
    cut += h + w.gap;
    freed += w.costOf(i);
  }
  return n;
}

/** Unmounts from the top up to `px` of items, down to the limits. @param {any} w the window @param {number} px @param {{ items: number, elements: number }} over */
export function dropTop(w, px, over) {
  const n = dropCount(w, w.from, 1, px, over);
  if (!n) return;
  // Every item dropped was mounted, so measured: the spacer stands in for exactly their height, and nothing moves.
  // view-state holds the anchor through any change in size that’s left (holdAnchor).
  const keep = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.from + n]));
  for (let i = w.from; i < w.from + n; i++) w.drop(i);
  w.from += n;
  w.el.insertBefore(w.above, keep);
  w.paintSpacers();
}

/** Unmounts from the bottom up to `px` of items, down to the limits. @param {any} w the window @param {number} px @param {{ items: number, elements: number }} over */
export function dropBottom(w, px, over) {
  const n = dropCount(w, w.to - 1, -1, px, over);
  if (!n) return;
  for (let i = w.to - n; i < w.to; i++) w.drop(i);
  w.to -= n;
  const last = /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[w.to - 1]));
  last.after(w.below);
  w.paintSpacers();
}

/**
 * Asks for grow() just after the next frame’s layout, where its reads of where things are cost nothing; read in the
 * frame, they forced a layout for each reply that arrived while you read (#1047). Once at a time.
 * @param {any} w the window
 */
export function scheduleGrow(w) {
  if (w.raf || w.timer) return;
  w.raf = requestAnimationFrame(() => {
    w.raf = 0;
    w.timer = setTimeout(() => w.grow(), 0);
  });
}

/**
 * An island moved to the end (item.move): the page’s copy at its old place is now the stub (thread.mjs swaps it in),
 * which no island is held for. Left in `islands`, it stayed on the page outside the range once focus left it, and a
 * second stub was drawn when the range reached its place. So it leaves now, gap and all; the stub draws from the
 * state when the range reaches it. @param {any} w the window @param {number} at its index @param {string} stubId
 */
export function dropMovedIsland(w, at, stubId) {
  if (!w.islands.has(at)) return;
  w.islands.delete(at);
  w.gaps.get(at)?.remove();
  w.gaps.delete(at);
  w.nodes.get(stubId)?.remove();
  w.nodes.delete(stubId);
  w.paintSpacers();
}

/**
 * Moves the range to item i, for a jump to an item that isn’t on the page: everything mounted leaves (but what has
 * focus, which stays as an island), and the range opens around i, as a conversation opens around its anchor. The
 * jump then scrolls to it.
 * @param {any} w the window @param {number} i
 */
export function recenter(w, i) {
  // An island rejoins through a fragment, which takes it off the page for a moment and so drops its focus.
  const active = document.activeElement;
  for (let k = w.from; k < w.to; k++) w.drop(k);
  [w.from, w.to] = w.openRange(i);
  w.below.before(w.above);
  // Each island goes to its side of the new range, in order: above it, or below it.
  const islands = [...w.islands.keys()].sort((a, b) => a - b);
  for (const k of islands.filter((k) => k < w.from)) w.above.before(/** @type {HTMLElement} */ (w.islands.get(k)));
  for (const k of islands.filter((k) => k >= w.to).reverse()) w.below.after(/** @type {HTMLElement} */ (w.islands.get(k)));
  w.mountRun(w.from, w.to, w.below);
  w.paintSpacers();
  refocus(active);
}

/**
 * Gives focus back to what had it before an island went through a fragment, if it’s on the page again and lost it.
 * @param {Element | null} active
 */
export function refocus(active) {
  if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
}

/**
 * Item `old` was drawn again as `next` (thread.mjs, rerender): the sizes observer and an island’s place follow the new
 * node, so the spacers measure what’s on the page, and a release takes it off when focus leaves. Before, an island
 * kept the old node, and its release left the new one on the page, out of the range, to show twice later (#1075).
 * O(islands), a few at most. @param {any} w the window @param {HTMLElement} old @param {HTMLElement} next
 */
export function replaced(w, old, next) {
  w.sizes.unobserve(old);
  w.sizes.observe(next);
  for (const [i, node] of w.islands) if (node === old) w.islands.set(i, next);
}

/**
 * The index of the item at `px` below the top of the conversation’s first item, by the heights the spacers use: a
 * binary search over the spans, O(kinds × log² n). @param {any} w the window @param {number} px
 */
function indexAt(w, px) {
  let lo = 0;
  let hi = w.total - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (w.spanOf(0, m) + w.gap <= px) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** Item i’s rect; it’s mounted, as the range’s first or last item. @param {any} w the window @param {number} i */
const mountedAt = (w, i) => /** @type {HTMLElement} */ (w.nodes.get(w.entry.ids[i])).getBoundingClientRect();

/**
 * Where the conversation starts on the page: its first element, where it’s shown, since the spacers sit where they
 * were painted, with the estimates of then. The top spacer is hidden when empty, with a rect of all zeros, and then
 * the range starts the conversation. @param {any} w the window @param {number} rangeTop the range’s first item’s top
 */
function conversationTop(w, rangeTop) {
  const first = /** @type {HTMLElement} */ (w.el.firstElementChild);
  if (first.getClientRects().length > 0) return first.getBoundingClientRect().top;
  return rangeTop - w.spanOf(0, w.from) - (w.from > 0 ? w.gap : 0);
}

/**
 * A scroll that left the view past the margin of both of the range’s edges, so growing from an edge would show blank
 * spacer until enough scroll events walk the range over: the range moves to the item under the middle of the view,
 * and the view to it, or to the end if it was at the end (End). Returns whether it did. @param {any} w the window
 */
export function leap(w) {
  const reach = w.viewH() * MARGIN;
  // From the mounted items, not the spacers: an empty spacer is hidden, and a hidden element’s rect is all zeros.
  const rangeTop = mountedAt(w, w.from).top;
  const rangeBottom = mountedAt(w, w.to - 1).bottom;
  if (rangeBottom >= -reach && rangeTop <= w.viewH() + reach) return false;
  const box = /** @type {Element} */ (w.inPanel ? w.el.parentElement : document.scrollingElement);
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight <= 2;
  const mid = (w.inPanel ? box.getBoundingClientRect().top : 0) + box.clientHeight / 2;
  const itemsTop = conversationTop(w, rangeTop);
  const i = indexAt(w, mid - itemsTop);
  recenter(w, i);
  // The items drew at their real heights, not the estimates the spacers stood in with, so the view goes where you were.
  const node = w.nodes.get(w.entry.ids[i]);
  if (atEnd) box.scrollTop = box.scrollHeight;
  else if (node) box.scrollTop += node.getBoundingClientRect().top - mid;
  return true;
}
