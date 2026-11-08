// The items a transcript counts (#866, W5): the ones that draw. A reply replaced by its replay draws nothing (#120),
// so a screen reader’s place in the conversation (window-a11y.mjs), Alt+↑/↓, Home and End (item-nav.mjs) all skip it. They go
// by the conversation’s state, not the page, so an item the window holds off the page counts too.

import { itemsOf, placeIn } from './client.mjs';

/** Whether an item draws in the transcript; thread.mjs draws a replaced reply as an empty hidden line. @param {any} it */
export const draws = (it) => !(it.kind === 'agent' && it.status === 'replaced');

/** The id of the first item that draws from index `from`, going by `step`; null past the end. @param {any[]} list @param {number} from @param {number} step */
function walk(list, from, step) {
  for (let i = from; i >= 0 && i < list.length; i += step) if (draws(list[i])) return list[i].id;
  return null;
}

/**
 * The id of the item that draws `step` (1 or -1) from item `id` in a conversation, or `id` itself at either end. From
 * outside any item (null, or an id it doesn’t hold), the last one.
 * @param {string} threadId @param {string | null} id @param {number} step
 * @returns {string | null}
 */
export function neighborOf(threadId, id, step) {
  const list = itemsOf(threadId);
  const at = id === null ? -1 : placeIn(threadId, id);
  if (at < 0) return walk(list, list.length - 1, -1);
  return walk(list, at + step, step) ?? id;
}

/** The id of a conversation’s first or last item that draws. @param {string} threadId @param {'first' | 'last'} end */
export function edgeOf(threadId, end) {
  const list = itemsOf(threadId);
  return end === 'first' ? walk(list, 0, 1) : walk(list, list.length - 1, -1);
}
