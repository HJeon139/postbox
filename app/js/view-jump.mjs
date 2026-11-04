// A jump to something in a transcript, by a link, a button or a key (#712). With items skipped by content-visibility,
// it lands where their estimates put it; the items between then draw at their real sizes. Holding the item across the
// middle, as a scroll does, would push the target away, so a jump makes its target's item the anchor, kept until you
// scroll (view-state.mjs, pin()). Every jump to an item goes through jumpTo; tests/view-jump-sites.test.mjs finds any
// that doesn't.

/** @typedef {{ box: () => Element | null, top: () => number, pin: (item: HTMLElement) => void }} Jumpable */

/** Each mounted transcript's view, so a jump from anywhere on the page finds the one its target is in. */
const views = /** @type {WeakMap<Element, Jumpable>} */ (new WeakMap());
/** @param {Element} el @param {Jumpable} view */
export const register = (el, view) => views.set(el, view);
/** @param {Element} el */
export const unregister = (el) => views.delete(el);

/**
 * Where el should start in the view for that block, or null when it needn't move ('nearest', already in view).
 * @param {number} top el's top in the view @param {number} height el's height @param {number} room the view's height
 * @param {'start' | 'center' | 'nearest'} block
 */
export function wantedTop(top, height, room, block) {
  if (block === 'start') return 0;
  if (block === 'center') return Math.max(0, (room - height) / 2);
  if (top >= 0 && top + height <= room) return null;
  if (top < 0) return 0;
  return Math.max(0, room - height);
}

/**
 * Puts el where block says, and its item becomes its transcript's anchor. Outside a transcript, a plain scrollIntoView.
 * @param {Element} el @param {'start' | 'center' | 'nearest'} [block]
 */
export function jumpTo(el, block = 'center') {
  const item = el.closest('.transcript > [data-key]');
  const view = item?.parentElement ? views.get(item.parentElement) : undefined;
  const s = view?.box();
  if (!view || !s || !(item instanceof HTMLElement)) {
    el.scrollIntoView({ block });
    return;
  }
  const r = el.getBoundingClientRect();
  const top = r.top - view.top();
  const wanted = wantedTop(top, r.height, s.clientHeight, block);
  if (wanted !== null) s.scrollTop += top - wanted;
  view.pin(item);
}
