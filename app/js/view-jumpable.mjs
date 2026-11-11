// What view-jump.mjs needs of a transcript's view, and the pin a jump leaves where it landed (#712). Moved from
// view-state.mjs, unchanged.

import { inSight, measure } from './view-box.mjs';
import { atEnd, box, gapOf, heldBy, viewTop } from './view-geometry.mjs';
import { PILL_ROOM, seen, showJump } from './view-pill.mjs';
import { publish } from './view-publish.mjs';
import { halt } from './view-smooth.mjs';

/** @typedef {import('./view-state.mjs').View} View */

/**
 * After a jump has put item where it was sent: it’s the anchor, kept until you scroll (#712, view-jump.mjs).
 * @param {View} v @param {HTMLElement} item
 */
function pin(v, item) {
  const s = box(v);
  if (!s || v.dead) return;
  v.stuck = atEnd(s);
  v.pinned = !v.stuck;
  if (v.stuck) v.held = measure(v, s);
  v.anchor = { key: /** @type {string} */ (item.dataset.key), at: item.getBoundingClientRect().top - viewTop(v, s) };
  v.lastTop = s.scrollTop;
  if (gapOf(s) <= PILL_ROOM) seen(v);
  showJump(v, s);
  publish(v);
}
/** What view-jump.mjs needs of a view. @param {View} v */
export const jumpable = (v) => ({
  box: () => box(v),
  seen: () => inSight(v),
  halt: () => halt(v),
  pin: (/** @type {HTMLElement} */ item) => pin(v, item),
  held: () => heldBy(v),
});
