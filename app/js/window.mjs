// The transcript window, slice W1 (#866; the sprint 4 window note, r2): a long conversation mounts only the items
// around where you are, with a spacer above and below standing in for the rest at about their height
// (window-heights.mjs), so opening it builds a bounded number of items however long it is. It grows toward a spacer
// as you scroll (W1), and past its ceiling of items or its budget of elements (window-cost.mjs, #1155) unmounts what’s
// furthest from the view (W2). An item with focus stays mounted where it is, between spacers of its own, until focus
// leaves it; an item’s open details come back when it’s mounted again. It’s on by default for a conversation over its
// ceiling or its budget (the person’s choice of 8 Nov); find-in-page, select-all and print see only what’s mounted,
// and search (W4) covers the rest.
//
//   localStorage.setItem('pb-window', 'off')    turns it off in this browser

import { h } from './dom.mjs';
import { restoreDetails } from './rerender-state.mjs';
import { holdView } from './view-jump.mjs';
import { holdSkipping } from './view-skip.mjs';
import { budgetFor, elementsOf } from './window-cost.mjs';
import { elementsIn, heightsFor, kindOf } from './window-entry.mjs';
import { windowOn } from './window-flag.mjs';
import { CEILING, CHUNK, FLOOR, MARGIN } from './window-limits.mjs';
import { live } from './window-live.mjs';
import * as windowShrink from './window-shrink.mjs';

/**
 * A window over one transcript, or null when it’s off or the conversation is short enough to mount whole.
 * mount(i) renders item i, keeps its node in the transcript’s map, and returns it.
 * edges, for a conversation loaded by range (open-threads.mjs, #1155): whether the server has items past an edge of the
 * list, and loading them. A conversation with more there gets a window however short its list, to load at its edges.
 * @param {{ el: HTMLElement, key: string, list: any[], anchorKey: string | null, inPanel: boolean,
 *   mount: (i: number) => HTMLElement, nodes: Map<string, HTMLElement>, edges?: Edges }} o
 */
export function createWindow(o) {
  // Mounted whole only within both the ceiling of items and the budget of elements (window-cost.mjs), and with nothing
  // more on the server past either edge.
  const more = !!o.edges && (o.edges.more('before') || o.edges.more('after'));
  if (!windowOn() || (o.list.length <= CEILING && !more && elementsIn(o.key, o.list) <= budgetFor(o.el))) return null;
  return new TranscriptWindow(o);
}

/**
 * @typedef {{ more: (side: 'before' | 'after') => boolean, grow: (side: 'before' | 'after') => void,
 *   edge: (side: 'before' | 'after') => Promise<unknown> }} Edges
 */

class TranscriptWindow {
  /** @param {Parameters<typeof createWindow>[0]} o */
  constructor({ el, key, list, anchorKey, inPanel, mount, nodes, edges }) {
    this.el = el;
    this.edges = edges ?? null;
    this.nodes = nodes;
    /** Items kept on the page outside the range, by index, and the spacer before each. @type {Map<number, HTMLElement>} */
    this.islands = new Map();
    /** @type {Map<number, HTMLElement>} */
    this.gaps = new Map();
    /** Each unmounted item’s open details, by id, until it’s mounted again. @type {Map<string, Map<string, boolean>>} */
    this.saved = new Map();
    this.inPanel = inPanel;
    this.mount = mount;
    this.anchorKey = anchorKey;
    this.entry = heightsFor(key, list);
    this.heights = this.entry.heights;
    /** @type {Map<string, number>} */
    this.indexOf = new Map(this.entry.ids.map((/** @type {string} */ id, /** @type {number} */ i) => [id, i]));
    this.above = h('div.win-spacer', { 'aria-hidden': 'true', dataset: { spacer: 'above' } });
    this.below = h('div.win-spacer', { 'aria-hidden': 'true', dataset: { spacer: 'below' } });
    this.gap = 0;
    this.budget = 0; // the elements it may hold, set as its range opens (openRange)
    this.width = 0;
    this.from = 0;
    this.to = 0;
    this.raf = 0;
    this.timer = 0;
    this.sizes = new ResizeObserver((entries) => this.measured(entries));
    this.scrolled = () => windowShrink.scheduleGrow(this);
  }
  get total() {
    return this.entry.ids.length;
  }
  viewH() {
    return (this.inPanel ? this.el.parentElement?.clientHeight : 0) || innerHeight;
  }
  scroller() {
    return this.inPanel ? /** @type {HTMLElement} */ (this.el.parentElement) : window;
  }
  /** The height items [a, b) take with the gaps between them, as a spacer standing in for them must. @param {number} a @param {number} b */
  spanOf(a, b) {
    return b > a ? this.heights.span(a, b) + (b - a - 1) * this.gap : 0;
  }
  fill(spacer, a, b) {
    return windowShrink.fill(this, spacer, a, b);
  }
  gapBefore(i) {
    return windowShrink.gapBefore(this, i);
  }
  paintSpacers() {
    return windowShrink.paintSpacers(this);
  }
  paintBelow() {
    windowShrink.paintSpacers(this, false);
  }
  /**
   * Each mounted item’s height as laid out; its first measurement sets its kind’s estimate. Only the spacer below
   * follows at once: changing the one above would move what you read. It takes them when the range next grows up.
   * @param {ResizeObserverEntry[]} entries
   */
  measured(entries) {
    // A new width rewraps every item, so what was measured at the old one is stale; the estimates stay (the note’s
    // “Heights”). The items on the page are measured again below.
    const width = this.el.clientWidth;
    if (this.width && width !== this.width) this.heights.forget();
    this.width = width;
    for (const e of entries) {
      const i = this.indexOf.get(/** @type {HTMLElement} */ (e.target).dataset.key ?? '');
      if (i === undefined) continue;
      this.heights.measure(i, e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height);
      this.counted(i, e.target);
    }
    this.paintBelow();
  }
  /** Where the range opens: the kept anchor, or the newest item. */
  openCenter() {
    const anchored = this.anchorKey ? this.indexOf.get(this.anchorKey) : undefined;
    return anchored ?? this.total - 1;
  }
  /** The range to open on: around the anchor, or the newest items, covering the view and its margins by estimate. */
  openRange(center = this.openCenter()) {
    const total = this.total;
    const reach = this.viewH() * (MARGIN + 0.5);
    // The rest of the page is counted here, as the range opens, not at each scroll: it walks the whole document.
    const budget = (this.budget = budgetFor(this.el));
    let a = center;
    let b = center + 1;
    let cost = this.costOf(center);
    // Within the ceiling of items and the budget of elements, whichever comes first.
    const fits = (/** @type {number} */ i) => b - a < CEILING && cost + this.costOf(i) <= budget;
    while (a > 0 && fits(a - 1) && this.heights.span(a, center + 1) < reach) cost += this.costOf(--a);
    while (b < total && fits(b) && this.heights.span(center, b) < reach) cost += this.costOf(b++);
    while (a > 0 && b - a < FLOOR && fits(a - 1)) cost += this.costOf(--a);
    return [a, b];
  }
  /** Item i’s cost in elements: as counted when it was mounted, else its kind’s estimate (window-cost.mjs). @param {number} i */
  costOf(i) {
    return this.entry.costs.of(this.entry.ids[i], this.entry.kinds[i]);
  }
  /** Counts mounted item i’s elements. @param {number} i @param {Element} node */
  counted(i, node) {
    this.entry.costs.count(this.entry.ids[i], this.entry.kinds[i], elementsOf(node));
  }
  /** Mounts items [a, b) before `before`, in order. @param {number} a @param {number} b @param {Node} before */
  mountRun(a, b, before) {
    const active = document.activeElement; // an island that rejoins through the fragment drops its focus
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) frag.append(this.islands.has(i) ? this.rejoin(i) : this.fresh(i));
    this.el.insertBefore(frag, before);
    windowShrink.refocus(active);
  }
  /** Item i, rendered from the state, with the details it had open when it left. @param {number} i */
  fresh(i) {
    const node = this.mount(i);
    this.counted(i, node);
    this.sizes.observe(node);
    restoreDetails(node, this.saved.get(this.entry.ids[i]));
    this.saved.delete(this.entry.ids[i]);
    return node;
  }
  rejoin(i) {
    return windowShrink.rejoin(this, i);
  }
  pinned(node) {
    return windowShrink.pinned(node);
  }
  drop(i) {
    return windowShrink.drop(this, i);
  }
  /** How many items to mount past an edge, going by step: the margin by estimate, at least CHUNK. @param {number} edge @param {number} step */
  runLength(edge, step) {
    const reach = this.viewH() * MARGIN;
    let n = 0;
    let covered = 0;
    for (let i = edge; i >= 0 && i < this.total && (covered < reach || n < CHUNK); i += step) {
      covered += this.heights.span(i, i + 1);
      n++;
    }
    return n;
  }
  /** Grows the range toward a spacer that’s within the margin of the view, holding what you see in place. */
  grow() {
    this.timer = 0;
    if (!this.el.isConnected) return;
    this.release();
    // A scroll far past both edges (the scrollbar dragged, Home, End) moves the range there at once.
    if (windowShrink.leap(this)) return holdView(this.el);
    const reach = this.viewH() * MARGIN;
    const nearTop = this.above.getBoundingClientRect().bottom > -reach;
    if (this.from > 0 && nearTop) this.growUp();
    // Past what’s loaded, the next range from the server; it lands as a rebuild around where you are (thread.mjs).
    else if (nearTop) this.edges?.grow('before');
    if (this.to === this.total && this.below.getBoundingClientRect().top < this.viewH() + reach) this.edges?.grow('after');
    if (this.to < this.total && this.below.getBoundingClientRect().top < this.viewH() + reach) {
      const b = this.to + this.runLength(this.to, 1);
      this.mountRun(this.to, b, this.below);
      this.to = b;
      this.paintBelow();
    }
    this.shrink();
  }
  release() {
    return windowShrink.release(this);
  }
  shrink() {
    return windowShrink.shrink(this);
  }
  dropTop(px, over) {
    return windowShrink.dropTop(this, px, over);
  }
  dropBottom(px, over) {
    return windowShrink.dropBottom(this, px, over);
  }
  /** Mounts a run above the range; the item that was first keeps its place on screen. */
  growUp() {
    const first = /** @type {HTMLElement} */ (this.above.nextElementSibling);
    const top = first.getBoundingClientRect().top;
    const a = this.from - this.runLength(this.from - 1, -1);
    this.mountRun(a, this.from, first);
    this.from = a;
    this.paintSpacers();
    const moved = first.getBoundingClientRect().top - top;
    if (Math.abs(moved) < 1) return;
    this.scroller().scrollBy(0, moved);
    // The view takes its anchor where this left it, now, and doesn’t take the move for yours (view-state.mjs).
    holdView(this.el);
  }
  /** Mounts the opening range between its spacers, then grows as you scroll. */
  build() {
    live.add(this);
    holdSkipping(this.el, true);
    [this.from, this.to] = this.openRange();
    this.el.append(this.above, this.below);
    this.mountRun(this.from, this.to, this.below);
    // Built on the page (a range landing, #1155), the gap between items is known now: the spacers are right at once.
    if (this.el.isConnected) this.gap = this.gapOf();
    this.paintSpacers();
    requestAnimationFrame(() => {
      // Torn down before its first frame (a room switch, a resync): nothing to listen for.
      if (!live.has(this)) return;
      const gap = this.gapOf();
      this.budget = budgetFor(this.el); // the rest of the page, now that it’s built around the transcript
      // Painted again only if the gap moved them, as a layout more for nothing otherwise.
      if (gap !== this.gap) {
        this.gap = gap;
        this.paintSpacers();
      }
      this.scroller().addEventListener('scroll', this.scrolled, { passive: true });
      this.scrolled();
    });
  }
  /** The gap between items, from the transcript's style. */
  gapOf() {
    return Number.parseFloat(getComputedStyle(this.el).rowGap) || 0;
  }
  /** A new item at the end: whether to mount it, which it is when the range already reaches the end. @param {any} it */
  added(it) {
    const atEnd = this.to === this.total;
    this.indexOf.set(it.id, this.total);
    this.heights.push(kindOf(it));
    this.entry.ids.push(it.id);
    this.entry.kinds.push(kindOf(it));
    if (atEnd) this.to++;
    else this.paintBelow();
    this.scrolled();
    return atEnd;
  }
  /** An item moved to the end, its stub in its old place (item.move). @param {any} stub @param {any} it */
  moved(stub, it) {
    this.restub(stub, it.id);
    return this.added(it);
  }
  /**
   * An item's stub takes its place, the item gone past the end of what's loaded (item-ranges.mjs, #1155).
   * @param {any} stub @param {string} id
   */
  restub(stub, id) {
    const at = this.indexOf.get(id);
    if (at === undefined) return;
    this.indexOf.delete(id);
    this.indexOf.set(stub.id, at);
    this.entry.ids[at] = stub.id;
    this.entry.kinds[at] = kindOf(stub);
    this.heights.retype(at, kindOf(stub));
    windowShrink.dropMovedIsland(this, at, stub.id);
  }
  /** Measures a node the transcript mounted at the end itself. @param {Element} node */
  observe(node) {
    this.sizes.observe(node);
  }
  /** How many items are mounted. */
  get size() {
    return this.to - this.from;
  }
  /** Item `id`’s node, mounting the range around it if it’s off the page; null if this window doesn’t hold it. @param {string} id */
  reach(id) {
    const i = this.indexOf.get(id);
    if (i === undefined || !this.el.isConnected) return null;
    // Outside the range, kept or not: an island kept for its focus is reached by moving the range to it.
    if (i < this.from || i >= this.to) windowShrink.recenter(this, i);
    return this.nodes.get(id) ?? null;
  }
  destroy() {
    live.delete(this);
    holdSkipping(this.el, false);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.sizes.disconnect();
    this.scroller()?.removeEventListener('scroll', this.scrolled);
  }
}
