// Where a transcript’s view listens: the scroll of its box, the window’s size, and the sizes of the transcript and
// what’s around it, and the pointer (view-hold.mjs). Moved from view-state.mjs at its size limit.

import { onPointerMoved } from './pointer-rest.mjs';
import { box } from './view-geometry.mjs';
import { DRAWN } from './view-skip.mjs';

/** @typedef {import('./view-state.mjs').View} View */

/** @param {View} v @param {() => void} scrolled @param {() => void} resized @param {() => void} pointed */
export function bind(v, scrolled, resized, pointed) {
  const s = box(v);
  if (v.bound || !s || !v.el.isConnected) return;
  v.bound = v.inPanel ? s : window;
  v.bound.addEventListener('scroll', scrolled, { passive: true });
  addEventListener('resize', resized);
  v.sizes.observe(v.el);
  v.unpoint = onPointerMoved(pointed);
  // An item's first draw can grow inside the height held while stuck, unseen by v.sizes (view-skip.mjs, DRAWN).
  v.el.addEventListener(DRAWN, resized, true);
  // What’s around it changing moves the end too: the composer, the panel’s height, the thread’s root above. A shrink
  // there clamps the view like one in the transcript, so its changes are noted the same way (#360). The panel’s
  // composer isn’t beside the transcript: it’s in the panel’s foot, under the scroll box.
  const parent = v.el.parentElement;
  const around = parent ? [...parent.children].filter((n) => n !== v.el) : [];
  const foot = v.inPanel ? v.el.closest('.sidepanel')?.querySelector('.sp-foot') : null;
  if (parent) v.sizes.observe(parent);
  for (const n of foot ? [...around, foot] : around) {
    v.sizes.observe(n);
    v.changes.observe(n, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }
}
/** What bind() and mountView() listen to and observe, let go. @param {View} v @param {() => void} scrolled @param {() => void} resized */
export function unbind(v, scrolled, resized) {
  v.unpoint?.();
  v.sizes.disconnect();
  v.changes.disconnect();
  v.bound?.removeEventListener('scroll', scrolled);
  v.el.removeEventListener(DRAWN, resized, true);
  removeEventListener('resize', resized);
}
