// What the transcript window’s items cost in elements (#1155, item 2): the window budgets the elements on the page, not
// a count of items, since a review, a choice or a table, or an app’s frame, costs many times a line of text. The budget
// is #1166’s, about 5,000 elements for the whole page; a window takes what the rest of the page leaves.

/** The page’s element budget (#1166): every element on it, the transcript’s and the shell’s. */
export const PAGE_ELEMENTS = 5000;
/**
 * What an app’s frame costs beyond its own element: its document isn’t this page’s, so it isn’t counted with it, but it
 * lays out and paints as a page of its own.
 */
export const FRAME_COST = 250;
/** The least a window takes, so a page with a heavy shell still shows the items in view. */
const LEAST = 1000;
// First estimates by kind, in elements, from a 1,000-item room at 1280 px (an agent’s reply with its steps about 22, a
// table of five rows about 73); a kind’s own counts replace them.
const SEEDS = { user: 12, agent: 24, sys: 6, voice: 8, block: 60, 'block:table': 80, 'block:review': 120, 'block:form': 80, 'block:app': 40 + FRAME_COST };
const UNKNOWN = 30;

/** An item’s cost as mounted: itself, its elements, and each app frame in it. @param {Element} node */
export function elementsOf(node) {
  return node.getElementsByTagName('*').length + 1 + node.getElementsByTagName('iframe').length * FRAME_COST;
}

/**
 * The elements a window over `el` may hold: the page’s budget, less what the rest of the page has (another window’s
 * items, the rail, the composer), and never less than LEAST. @param {HTMLElement} el
 */
export function budgetFor(el) {
  const all = document.getElementsByTagName('*').length;
  const mine = el.isConnected ? el.getElementsByTagName('*').length : 0;
  return Math.max(LEAST, PAGE_ELEMENTS - (all - mine));
}

/** Each item’s cost, counted once it’s mounted, and each kind’s mean of those counts for the items not yet mounted. */
export class Costs {
  constructor() {
    /** @type {Map<string, number>} */
    this.counted = new Map();
    /** @type {Map<string, { sum: number, n: number }>} */
    this.kinds = new Map();
  }
  /** Item `id`, of `kind`, counted at `n` elements. @param {string} id @param {string} kind @param {number} n */
  count(id, kind, n) {
    const was = this.counted.get(id);
    if (was === n) return;
    const k = this.kinds.get(kind) ?? { sum: 0, n: 0 };
    if (was === undefined) k.n++;
    k.sum += n - (was ?? 0);
    this.kinds.set(kind, k);
    this.counted.set(id, n);
  }
  /** A kind’s estimate: the mean of its counts, else its seed. @param {string} kind */
  estimate(kind) {
    const k = this.kinds.get(kind);
    if (k?.n) return k.sum / k.n;
    const base = kind.split(':')[0];
    if (Object.hasOwn(SEEDS, kind)) return SEEDS[kind];
    return Object.hasOwn(SEEDS, base) ? SEEDS[base] : UNKNOWN;
  }
  /** Item `id`’s cost: as counted, else its kind’s estimate. @param {string} id @param {string} kind */
  of(id, kind) {
    return this.counted.get(id) ?? this.estimate(kind);
  }
}
