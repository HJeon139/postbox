// The transcript windows on the page (#866, window.mjs): the ones a jump to an item asks, and the one Home and End
// move (window-keys.mjs).

import { edgeKeys } from './window-keys.mjs';

/** Every window on the page, so a jump to an item can find the one that holds it (window.mjs adds and removes them). @type {Set<any>} */
export const live = new Set();
edgeKeys(live);

/**
 * The node for an item a window holds, mounting the range around it first if it’s off the page; null when no window
 * holds it (the window is off, or the item isn’t in a long transcript). Every jump to an item asks this before it
 * looks for the item on the page (#866, W3).
 * @param {string} itemId
 * @returns {HTMLElement | null}
 */
export function mountFor(itemId) {
  for (const w of live) {
    const node = w.reach(itemId);
    if (node) return node;
  }
  return null;
}
