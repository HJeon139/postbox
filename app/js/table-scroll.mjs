// A table wider than its block fades the edge that has more columns past it, and the fade follows the scroll (#1000).
// The fades are drawn by the frame around the scroll region, above the table, so the sticky header’s opaque cells
// can’t cover them, as they would a background-attachment: local shadow. One observer follows every live table as its
// block, its window or its columns change width; a scroll listener on each region follows the person.

import { h } from './dom.mjs';

/** Shows a fade on each side with more to scroll to, kept clear of the region’s own scrollbars. @param {Element} frame */
function update(frame) {
  const wrap = /** @type {HTMLElement | null} */ (frame.firstElementChild);
  if (!wrap) return;
  // A pixel of slack, for a zoomed page’s fractional scroll positions.
  const more = wrap.scrollWidth - wrap.clientWidth > 1;
  frame.classList.toggle('more-left', more && wrap.scrollLeft > 1);
  frame.classList.toggle('more-right', more && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
  const el = /** @type {HTMLElement} */ (frame);
  el.style.setProperty('--sb-right', `${wrap.offsetWidth - wrap.clientWidth - wrap.clientLeft}px`);
  el.style.setProperty('--sb-bottom', `${wrap.offsetHeight - wrap.clientHeight - wrap.clientTop}px`);
}

const watcher = new ResizeObserver((entries, observer) => {
  const frames = new Set();
  for (const { target } of entries) {
    if (!target.isConnected) observer.unobserve(target);
    else {
      const frame = target.closest('.tbl-scroll');
      if (frame) frames.add(frame);
      // Back where the person was, before the first paint of a table drawn anew; the browser clamps it to a smaller one.
      const at = kept.get(target);
      if (at) {
        kept.delete(target);
        Object.assign(target, { scrollLeft: at.left, scrollTop: at.top });
      }
    }
  }
  for (const frame of frames) update(frame);
});

/** A table drawn anew → where its scroll was, until the observer has put it back. */
const kept = new WeakMap();
/**
 * A table’s kept position → the scroll region drawn for it last, still on the page while its next is drawn. Held
 * weakly, so a table gone from the page isn’t kept alive by its position.
 */
const shown = new WeakMap();

/**
 * Wraps a table’s scroll region in the frame that draws its fades, and follows its width and scroll. `at` keeps its
 * scroll, sideways and down, across redraws (#1130): an agent’s update_block, Sort and Expand each draw the table anew.
 * @param {HTMLElement} wrap  the scroll region, holding the table @param {{ left: number, top: number }} [at]
 */
export function scrollFrame(wrap, at) {
  const frame = h('div.tbl-scroll', wrap);
  if (at) {
    // Read from the region on the page now: its last scroll event may not have arrived yet. Not from one whose own
    // position hasn’t been put back yet, as when it was drawn out of view, which still reads 0.
    const last = shown.get(at)?.deref();
    if (last?.isConnected && !kept.has(last)) Object.assign(at, { left: last.scrollLeft, top: last.scrollTop });
    shown.set(at, new WeakRef(wrap));
    if (at.left || at.top) kept.set(wrap, at);
  }
  wrap.addEventListener(
    'scroll',
    () => {
      // One that arrives after the region left the page reads 0, not where the person was.
      if (at && wrap.isConnected) Object.assign(at, { left: wrap.scrollLeft, top: wrap.scrollTop });
      update(frame);
    },
    { passive: true },
  );
  watcher.observe(wrap);
  if (wrap.firstElementChild) watcher.observe(wrap.firstElementChild);
  return frame;
}
