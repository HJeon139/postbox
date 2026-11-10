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
    }
  }
  for (const frame of frames) update(frame);
});

/**
 * Wraps a table’s scroll region in the frame that draws its fades, and follows its width and scroll.
 * @param {HTMLElement} wrap  the scroll region, holding the table
 */
export function scrollFrame(wrap) {
  const frame = h('div.tbl-scroll', wrap);
  wrap.addEventListener('scroll', () => update(frame), { passive: true });
  watcher.observe(wrap);
  if (wrap.firstElementChild) watcher.observe(wrap.firstElementChild);
  return frame;
}
