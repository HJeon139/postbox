// The item that has focus when a transcript is rebuilt for a range that landed (#1155): the rebuilt window takes the
// same node back, in its range or as an island beside it, so focus stays where it was, and the window keeps the item
// on the page until focus leaves it, as it does an item you scroll away from (#866, W2).

import { refocus } from './window-shrink.mjs';

/**
 * The transcript’s item that holds focus: its key, its node, and what in it has focus; null when nothing in it does.
 * @param {HTMLElement} el  the transcript
 */
export function focusedItem(el) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !el.contains(active)) return null;
  let node = /** @type {HTMLElement | null} */ (active);
  while (node && node.parentElement !== el) node = node.parentElement;
  const key = node?.dataset.key;
  return node && key ? { key, node, active } : null;
}

/**
 * Puts the item that had focus back in a window just built: in place of the node it mounted for that item, or as an
 * island if the item is outside its range. An item the rebuilt list doesn’t hold leaves with the rest.
 * @param {any} w  the window @param {ReturnType<typeof focusedItem>} kept
 */
export function keepFocused(w, kept) {
  const i = kept ? w.indexOf.get(kept.key) : undefined;
  if (!kept || i === undefined) return;
  const fresh = w.nodes.get(kept.key);
  if (fresh) {
    w.sizes.unobserve(fresh);
    fresh.replaceWith(kept.node);
  } else {
    w.islands.set(i, kept.node);
    if (i < w.from) w.above.before(kept.node);
    else w.below.after(kept.node);
  }
  w.nodes.set(kept.key, kept.node);
  w.sizes.observe(kept.node);
  w.paintSpacers();
  refocus(kept.active);
}
