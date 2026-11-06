// The transcript window, slice W1 (#866; the sprint 4 window note, r2): a long conversation mounts only the items
// around where you are, with a spacer above and below standing in for the rest at about their height
// (window-heights.mjs), so opening it builds a bounded number of items however long it is. In W1 the range only
// grows, as you scroll toward a spacer; it never unmounts (W2). It’s behind a flag until search (W4) and
// screen-reader support (W5) land, since find-in-page can’t see items that aren’t on the page.
//
//   localStorage.setItem('pb-window', 'on')    turns it on in this browser

import { h } from './dom.mjs';
import { createHeights } from './window-heights.mjs';

const FLAG = 'pb-window';
/** The fewest and most items a conversation mounts when it opens. The most is what bounds the page’s size. */
export const FLOOR = 40;
export const CEILING = 240;
/** How far past the view, in view heights, the range reaches on each side. */
const MARGIN = 2;
/** The fewest items a growth mounts at once. */
const CHUNK = 10;
// Rough first estimates by kind, in px, from prep-712’s 1,000-item room at 1280 px (median 71 px); a kind’s own
// measurements replace them.
const SEEDS = { user: 48, agent: 96, sys: 28 };

/** Whether the window is on in this browser. */
export function windowOn() {
  try {
    return localStorage.getItem(FLAG) === 'on';
  } catch {
    return false;
  }
}

/** An item’s kind for its height estimate: a block by its type, as a choice and a review differ most. @param {any} it */
const kindOf = (it) => (it.kind === 'block' ? `block:${it.block?.type ?? ''}` : it.kind);

/** Each conversation’s heights, kept across switches so measurements aren’t lost; keyed as `kept` is in thread.mjs. */
const cache = new Map();

/** The heights for a conversation’s items, the cached ones while they still match its list. @param {string} key @param {any[]} list */
function heightsFor(key, list) {
  let entry = cache.get(key);
  const matches = entry && entry.ids.length <= list.length && entry.ids.every((/** @type {string} */ id, /** @type {number} */ i) => list[i].id === id);
  if (!matches) {
    entry = { heights: createHeights(SEEDS), ids: /** @type {string[]} */ ([]) };
    cache.set(key, entry);
  }
  for (let i = entry.ids.length; i < list.length; i++) {
    entry.heights.push(kindOf(list[i]));
    entry.ids.push(list[i].id);
  }
  return entry;
}

/**
 * A window over one transcript, or null when it’s off or the conversation is short enough to mount whole.
 * mount(i) renders item i, keeps its node in the transcript’s map, and returns it.
 * @param {{ el: HTMLElement, key: string, list: any[], anchorKey: string | null, inPanel: boolean,
 *   mount: (i: number) => HTMLElement }} o
 */
export function createWindow(o) {
  if (!windowOn() || o.list.length <= CEILING) return null;
  return new TranscriptWindow(o);
}

class TranscriptWindow {
  /** @param {Parameters<typeof createWindow>[0]} o */
  constructor({ el, key, list, anchorKey, inPanel, mount }) {
    this.el = el;
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
    this.from = 0;
    this.to = 0;
    this.raf = 0;
    this.sizes = new ResizeObserver((entries) => this.measured(entries));
    this.scrolled = () => {
      if (!this.raf) this.raf = requestAnimationFrame(() => this.grow());
    };
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
  paintSpacers() {
    this.above.hidden = this.from === 0;
    this.above.style.height = `${this.spanOf(0, this.from)}px`;
    this.paintBelow();
  }
  paintBelow() {
    this.below.hidden = this.to === this.total;
    this.below.style.height = `${this.spanOf(this.to, this.total)}px`;
  }
  /**
   * Each mounted item’s height as laid out; its first measurement sets its kind’s estimate. Only the spacer below
   * follows at once: changing the one above would move what you read. It takes them when the range next grows up.
   * @param {ResizeObserverEntry[]} entries
   */
  measured(entries) {
    for (const e of entries) {
      const i = this.indexOf.get(/** @type {HTMLElement} */ (e.target).dataset.key ?? '');
      if (i !== undefined) this.heights.measure(i, e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height);
    }
    this.paintBelow();
  }
  /** The range to open on: around the anchor, or the newest items, covering the view and its margins by estimate. */
  openRange() {
    const total = this.total;
    const anchored = this.anchorKey ? this.indexOf.get(this.anchorKey) : undefined;
    const center = anchored ?? total - 1;
    const reach = this.viewH() * (MARGIN + 0.5);
    let a = center;
    let b = center + 1;
    while (a > 0 && b - a < CEILING && this.heights.span(a, center + 1) < reach) a--;
    while (b < total && b - a < CEILING && this.heights.span(center, b) < reach) b++;
    while (a > 0 && b - a < FLOOR) a--;
    return [a, b];
  }
  /** Mounts items [a, b) before `before`, in order. @param {number} a @param {number} b @param {Node} before */
  mountRun(a, b, before) {
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      const node = this.mount(i);
      this.sizes.observe(node);
      frag.append(node);
    }
    this.el.insertBefore(frag, before);
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
    this.raf = 0;
    if (!this.el.isConnected) return;
    const reach = this.viewH() * MARGIN;
    if (this.from > 0 && this.above.getBoundingClientRect().bottom > -reach) this.growUp();
    if (this.to < this.total && this.below.getBoundingClientRect().top < this.viewH() + reach) {
      const b = this.to + this.runLength(this.to, 1);
      this.mountRun(this.to, b, this.below);
      this.to = b;
      this.paintBelow();
    }
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
    if (Math.abs(moved) >= 1) this.scroller().scrollBy(0, moved);
  }
  /** Mounts the opening range between its spacers, then grows as you scroll. */
  build() {
    [this.from, this.to] = this.openRange();
    this.el.append(this.above, this.below);
    this.mountRun(this.from, this.to, this.below);
    this.paintSpacers();
    requestAnimationFrame(() => {
      this.gap = Number.parseFloat(getComputedStyle(this.el).rowGap) || 0;
      this.paintSpacers();
      this.scroller().addEventListener('scroll', this.scrolled, { passive: true });
      this.scrolled();
    });
  }
  /** A new item at the end: whether to mount it, which it is when the range already reaches the end. @param {any} it */
  added(it) {
    const atEnd = this.to === this.total;
    this.indexOf.set(it.id, this.total);
    this.heights.push(kindOf(it));
    this.entry.ids.push(it.id);
    if (atEnd) this.to++;
    else this.paintBelow();
    return atEnd;
  }
  /** An item moved to the end, its stub in its old place (item.move). @param {any} stub @param {any} it */
  moved(stub, it) {
    const at = this.indexOf.get(it.id);
    if (at !== undefined) {
      this.indexOf.delete(it.id);
      this.indexOf.set(stub.id, at);
      this.entry.ids[at] = stub.id;
      this.heights.retype(at, kindOf(stub));
    }
    return this.added(it);
  }
  /** Measures a node the transcript mounted at the end itself. @param {Element} node */
  observe(node) {
    this.sizes.observe(node);
  }
  /** How many items are mounted. */
  get size() {
    return this.to - this.from;
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.sizes.disconnect();
    this.scroller()?.removeEventListener('scroll', this.scrolled);
  }
}
