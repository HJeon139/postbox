// Moving through the transcript’s items by keyboard (#866, W5): Alt+↑/↓ to the item before or after, and Home and End
// on an item to the first and last. They step through the items that draw, by the conversation’s state
// (counted-items.mjs), so a replaced reply is stepped over and an item the window holds off the page is mounted first.

import { edgeOf, neighborOf } from './counted-items.mjs';
import { jumpTo } from './view-jump.mjs';
import { mountFor } from './window.mjs';

const main = () => document.getElementById('main');

/** Focuses item `id` of the transcript and brings it into view, mounting it first if it’s off the page. @param {HTMLElement} box @param {string | null} id */
function go(box, id) {
  if (!id) return;
  const node = mountFor(id) ?? box.querySelector(`:scope > [data-key="${CSS.escape(id)}"]`);
  if (!(node instanceof HTMLElement)) return;
  node.focus({ preventScroll: true });
  jumpTo(node, 'nearest');
}

/** Alt+↑/↓: the item before or after the one with focus; from outside any item, the last. @param {KeyboardEvent} e */
export function stepItems(e) {
  const box = main();
  const threadId = box?.dataset.thread;
  if (!box || !threadId || !box.querySelector(':scope > .item')) return;
  e.preventDefault();
  const at = /** @type {HTMLElement | null | undefined} */ (document.activeElement?.closest('#main > .item'));
  go(box, neighborOf(threadId, at?.dataset.key ?? null, e.key === 'ArrowDown' ? 1 : -1));
}

/**
 * Home and End on an item itself: the first or the last item. Only there: a field or a control inside an item keeps
 * them for its caret or its own keys.
 * @param {KeyboardEvent} e
 */
export function itemEdges(e) {
  const box = main();
  const t = e.target;
  const threadId = box?.dataset.thread;
  if (!box || !threadId || !(t instanceof HTMLElement) || t.parentElement !== box || !t.classList.contains('item')) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  go(box, edgeOf(threadId, e.key === 'Home' ? 'first' : 'last'));
}
