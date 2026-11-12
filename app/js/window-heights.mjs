// The transcript window’s heights (#866, designs: sprint 4 window note r2, “Heights”): what the items outside the
// mounted range would take, so its spacers stand in for them at about their real height. Pure, so node can test it.
//
// Measured heights live in a Fenwick tree over item indices (0 where unmeasured). Unmeasured items aren’t stored one
// by one: each kind keeps a tree of 0/1 marking its unmeasured items, and an estimate (the running median of its
// measured heights). So a span’s height is its measured sum plus, per kind, its unmeasured count × that kind’s
// estimate: O(kinds × log n). When an estimate moves, no item’s entry changes.

/** Prefix sums over a growing array, each update and query O(log n). */
export class Fenwick {
  /** @param {number} [n] */
  constructor(n = 0) {
    /** @type {number[]} */
    this.tree = [0];
    this.values = /** @type {number[]} */ ([]);
    this.updates = 0;
    for (let i = 0; i < n; i++) this.push(0);
  }
  get length() {
    return this.values.length;
  }
  /** Appends a value at the end. Amortised O(log n): the new node takes the sum of the span it covers. @param {number} v */
  push(v) {
    const i = this.values.length + 1;
    this.values.push(v);
    // Node i covers (i - lowbit(i), i]: its own value plus the nodes that tile the rest of that span.
    let sum = v;
    const low = i & -i;
    for (let j = i - 1; j > i - low; j -= j & -j) sum += this.tree[j];
    this.tree.push(sum);
  }
  /** Sets index i to v. @param {number} i @param {number} v */
  set(i, v) {
    const d = v - this.values[i];
    if (d === 0) return;
    this.updates++;
    this.values[i] = v;
    for (let j = i + 1; j < this.tree.length; j += j & -j) this.tree[j] += d;
  }
  /** The sum of indices [0, i). @param {number} i */
  prefix(i) {
    let s = 0;
    for (let j = Math.min(i, this.values.length); j > 0; j -= j & -j) s += this.tree[j];
    return s;
  }
  /** The sum of indices [from, to). @param {number} from @param {number} to */
  sum(from, to) {
    return to > from ? this.prefix(to) - this.prefix(from) : 0;
  }
}

/** A running median: two heaps, O(log m) per value. */
class Median {
  constructor() {
    /** @type {number[]} */
    this.low = []; // a max-heap, as negatives
    /** @type {number[]} */
    this.high = []; // a min-heap
  }
  /** @param {number} v */
  add(v) {
    if (!this.low.length || v <= -this.low[0]) heapPush(this.low, -v);
    else heapPush(this.high, v);
    if (this.low.length > this.high.length + 1) heapPush(this.high, -heapPop(this.low));
    else if (this.high.length > this.low.length) heapPush(this.low, -heapPop(this.high));
  }
  get size() {
    return this.low.length + this.high.length;
  }
  get value() {
    return this.size ? -this.low[0] : 0;
  }
}

/** @param {number[]} h @param {number} v */
function heapPush(h, v) {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p] <= h[i]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}
/** @param {number[]} h */
function heapPop(h) {
  const top = h[0];
  const last = /** @type {number} */ (h.pop());
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && h[l] < h[m]) m = l;
      if (r < h.length && h[r] < h[m]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

/** Every item’s height, measured or estimated by kind. */
export class Heights {
  /**
   * @param {Record<string, number>} seeds  each kind’s estimate before any is measured, in px
   * @param {number} fallback  the estimate for a kind with no seed
   */
  constructor(seeds = {}, fallback = 80) {
    this.seeds = seeds;
    this.fallback = fallback;
    this.measured = new Fenwick();
    /** @type {Map<string, { unmeasured: Fenwick, median: Median }>} */
    this.kinds = new Map();
    /** @type {string[]} */
    this.kindAt = [];
  }
  get length() {
    return this.kindAt.length;
  }
  /** A kind’s trees, made on first use with a 0 for every item so far. @param {string} k */
  kind(k) {
    let entry = this.kinds.get(k);
    if (!entry) {
      entry = { unmeasured: new Fenwick(this.kindAt.length), median: new Median() };
      this.kinds.set(k, entry);
    }
    return entry;
  }
  /** A kind’s estimate: the median of its first measurements, or its seed. @param {string} k */
  estimate(k) {
    const m = this.kinds.get(k)?.median;
    if (m?.size) return m.value;
    return this.seeds[k] ?? this.fallback;
  }
  /**
   * Takes each kind's measurements so far from another conversation's list's heights, for a list that replaced it
   * (a range placed for a jump, #1155): a kind's height doesn't depend on which of the conversation's items are loaded,
   * so the estimates hold where they were, and a spacer standing in for what isn't mounted keeps its height.
   * @param {Heights} from
   */
  carry(from) {
    for (const [k, entry] of from.kinds) if (entry.median.size) this.kind(k).median = entry.median;
  }
  /** Adds the next item, of kind k, unmeasured. @param {string} k */
  push(k) {
    this.kind(k);
    for (const [name, entry] of this.kinds) entry.unmeasured.push(name === k ? 1 : 0);
    this.measured.push(0);
    this.kindAt.push(k);
  }
  /** Item i measured at h px: its own entries only. @param {number} i @param {number} h */
  measure(i, h) {
    const entry = this.kind(this.kindAt[i]);
    // Its first measurement counts toward its kind’s estimate; a remeasure only corrects its own height.
    if (entry.unmeasured.values[i] === 1) {
      entry.unmeasured.set(i, 0);
      entry.median.add(h);
    }
    this.measured.set(i, h);
  }
  /** Item i becomes kind k (a stub takes a moved item’s place). @param {number} i @param {string} k */
  retype(i, k) {
    if (this.kindAt[i] === k) return;
    this.kind(this.kindAt[i]).unmeasured.set(i, 0);
    this.measured.set(i, 0);
    this.kindAt[i] = k;
    this.kind(k).unmeasured.set(i, 1);
  }
  /** A width change: every measurement is stale, the estimates stay. O(n), and only on a resize. */
  forget() {
    for (let i = 0; i < this.kindAt.length; i++) {
      this.measured.set(i, 0);
      this.kind(this.kindAt[i]).unmeasured.set(i, 1);
    }
  }
  /** The height of items [from, to): measured where known, estimated by kind where not. @param {number} from @param {number} to */
  span(from, to) {
    let h = this.measured.sum(from, to);
    for (const [k, entry] of this.kinds) {
      const n = entry.unmeasured.sum(from, to);
      if (n) h += n * this.estimate(k);
    }
    return h;
  }
  /** Updates made to the trees, for the test that an estimate moving touches no item. */
  get updates() {
    let n = this.measured.updates;
    for (const entry of this.kinds.values()) n += entry.unmeasured.updates;
    return n;
  }
}

/** @param {Record<string, number>} [seeds] @param {number} [fallback] */
export const createHeights = (seeds, fallback) => new Heights(seeds, fallback);
