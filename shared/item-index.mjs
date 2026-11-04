// One index from an item's id to its place in its conversation's list (#712b, designs/508/712b-item-index.md), so the
// reducer and every reader find an item in O(1), however long the conversation. It's kept outside the state, in a
// WeakMap keyed by the list itself: it's never in a snapshot, never sent to the page, and goes when its list goes.
//
// The contract: only the reducer writes a list (shared/state.mjs), by appending (item.add, and the item item.move puts
// last) or by replacing one entry in place, which it reports with noteReplaced (the stub item.move leaves behind).
// Nothing removes one item, so a place never shifts. A list that's replaced (a load, a Retry, a held view's copy) is a
// new key, indexed on its first lookup. Within that contract every answer is exact. Outside it, a hit is still checked
// against the list, so a stale hit costs a rebuild rather than a wrong item; a miss is trusted, so an id put in place
// behind the index's back isn't found until the list is indexed again. Ids are unique (newId); among appended
// duplicates the first wins, as find() did.

/** @typedef {{ at: Map<string, number>, seen: number }} ListIndex */

/** @type {WeakMap<readonly any[], ListIndex>} */
const INDEX = new WeakMap();
let rebuilds = 0;

/** Indexes positions from..to-1, keeping an id's earlier place while that place still holds it, as find() would. */
function indexRange(/** @type {readonly any[]} */ list, /** @type {ListIndex} */ ix, from, to) {
  for (let p = from; p < to; p++) {
    const id = list[p]?.id;
    const earlier = ix.at.get(id);
    const earlierHoldsIt = earlier !== undefined && earlier < p && list[earlier]?.id === id;
    if (!earlierHoldsIt) ix.at.set(id, p);
  }
}

/** The list's index, with any entries appended since the last lookup indexed. */
function indexOf(/** @type {readonly any[]} */ list) {
  let ix = INDEX.get(list);
  if (!ix) {
    ix = { at: new Map(), seen: 0 };
    INDEX.set(list, ix);
  }
  if (ix.seen < list.length) {
    indexRange(list, ix, ix.seen, list.length);
    ix.seen = list.length;
  }
  return ix;
}

/** Indexes the list again from nothing: only when a hit found another id at its place, which the reducer never leaves. */
function rebuild(/** @type {readonly any[]} */ list) {
  rebuilds++;
  const ix = { at: new Map(), seen: list.length };
  indexRange(list, ix, 0, list.length);
  INDEX.set(list, ix);
  return ix;
}

/**
 * The first position in the list whose item has this id, or -1. O(1), and amortized O(1) for each item appended.
 * @param {readonly any[]} list @param {string} id
 */
export function positionOf(list, id) {
  let p = indexOf(list).at.get(id);
  if (p !== undefined && list[p]?.id !== id) p = rebuild(list).at.get(id);
  return p ?? -1;
}

/** The first item in the list with this id, or undefined. @param {readonly any[]} list @param {string} id */
export function itemOf(list, id) {
  const p = positionOf(list, id);
  return p < 0 ? undefined : list[p];
}

/** Tells the index that the entry at position p was replaced in place (item.move's stub). @param {readonly any[]} list @param {number} p */
export function noteReplaced(list, p) {
  const ix = INDEX.get(list);
  const id = list[p]?.id; // a move with no stub leaves undefined there, as it did before the index (#632: never throw after a write)
  if (ix && p < ix.seen && id !== undefined) ix.at.set(id, p);
}

/** How many times a lookup found the index stale and rebuilt it: 0 in every flow the reducer drives (tests read it). */
export function rebuildCount() {
  return rebuilds;
}
