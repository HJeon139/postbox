// Each conversation’s measurements for the transcript window (#866), kept across switches so they aren’t lost: its
// items’ ids, kinds, heights and element costs (window-cost.mjs). Moved from window.mjs.

import { Costs } from './window-cost.mjs';
import { createHeights } from './window-heights.mjs';

// Rough first estimates by kind, in px, from prep-712’s 1,000-item room at 1280 px (median 71 px); a kind’s own
// measurements replace them.
const SEEDS = { user: 48, agent: 96, sys: 28 };

/** An item’s kind for its height estimate: a block by its type, as a choice and a review differ most. @param {any} it */
export const kindOf = (it) => (it.kind === 'block' ? `block:${it.block?.type ?? ''}` : it.kind);

/** Each conversation’s heights, kept across switches so measurements aren’t lost; keyed as `kept` is in thread.mjs. */
const cache = new Map();

/** The heights for a conversation’s items, the cached ones while they still match its list. @param {string} key @param {any[]} list */
export function heightsFor(key, list) {
  let entry = cache.get(key);
  const matches = entry && entry.ids.length <= list.length && entry.ids.every((/** @type {string} */ id, /** @type {number} */ i) => list[i].id === id);
  if (!matches) {
    entry = { heights: createHeights(SEEDS), costs: new Costs(), ids: /** @type {string[]} */ ([]), kinds: /** @type {string[]} */ ([]) };
    cache.set(key, entry);
  }
  for (let i = entry.ids.length; i < list.length; i++) {
    entry.heights.push(kindOf(list[i]));
    entry.ids.push(list[i].id);
    entry.kinds.push(kindOf(list[i]));
  }
  return entry;
}

/** What a conversation’s items cost in elements, by each one’s count or its kind’s estimate. @param {string} key @param {any[]} list */
export function elementsIn(key, list) {
  const { costs, ids, kinds } = heightsFor(key, list);
  let n = 0;
  for (let i = 0; i < ids.length; i++) n += costs.of(ids[i], kinds[i]);
  return n;
}
