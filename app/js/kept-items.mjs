// The items a conversation's range keeps apart from its list (#1155): its first items, for Home; its newest, for End,
// once Home has put the first in their place; and those around the asks ⌃J and an agent's open-asks link go to. Each is
// kept current from the stream's item events as item-ranges.mjs's gate() hears them. Moved from item-ranges.mjs.

import { itemOf, noteReplaced, positionOf } from '/shared/item-index.mjs';
import { apply } from '/shared/state.mjs';

/** @typedef {import('./item-ranges.mjs').Range} Range */

/**
 * The conversation's first items, kept apart for Home (a load's head, place), current from their own events: a patch or text
 * applies, and a moved item leaves its stub in its place, as off a range's end. An add goes past them.
 * @param {Range} r @param {string} type @param {any} d
 */
export function keepHead(r, type, d) {
  const at = r.head && type !== 'item.add' ? positionOf(r.head, d.id) : -1;
  if (at < 0 || !r.head) return;
  if (type === 'item.move') {
    r.head[at] = d.stub;
    noteReplaced(r.head, at);
  } else apply({ items: { [d.threadId]: r.head } }, type, d);
}

/**
 * The items around the asks ⌃J and the open-asks link go to (a load's asks, place), current from their own events as
 * the head is. @param {Range} r @param {string} type @param {any} d
 */
export function keepAsks(r, type, d) {
  if (type === 'item.add') return;
  for (const ask of r.asks ?? []) {
    const at = positionOf(ask.items, d.id);
    if (at < 0) continue;
    if (type === 'item.move') {
      ask.items[at] = d.stub;
      noteReplaced(ask.items, at);
    } else apply({ items: { [d.threadId]: ask.items } }, type, d);
  }
}

/**
 * A copy of an item the page holds outside the tail, in its range, its head or around an ask, or undefined.
 * @param {any} state @param {Range} r @param {any} d
 */
export function heldCopy(state, r, d) {
  for (const list of [state.items[d.threadId] ?? [], r.head ?? [], ...(r.asks ?? []).map((a) => a.items)]) {
    const it = itemOf(list, d.id);
    if (it) return structuredClone(it);
  }
  return undefined;
}

/**
 * The conversation's newest items, kept apart for End once Home has put the head in their place (placeHead): current
 * from their own events as the range they were, which reached the end, so an add joins them, and a move ends there.
 * An item moved to the end from outside them joins them too, as the page held it (`moving`, heldCopy); one the page
 * didn't hold lets them go, so End loads the newest items rather than put back a range without the newest (#1155).
 * @param {Range} r @param {string} type @param {any} d @param {any} [moving]
 */
export function keepTail(r, type, d, moving) {
  if (!r.tail) return;
  const kept = { items: { [d.threadId]: r.tail } };
  if (type === 'item.add') apply(kept, type, { ...d, item: structuredClone(d.item) });
  else if (positionOf(r.tail, d.id) >= 0) apply(kept, type, d);
  else if (type === 'item.move' && moving) r.tail.push(Object.assign(moving, d.patch));
  else if (type === 'item.move') r.tail = undefined;
}
