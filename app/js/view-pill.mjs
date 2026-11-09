// The jump pill’s count, “Jump to latest · n new” (#91), moved from view-state.mjs at its size limit.

import { gapOf } from './view-geometry.mjs';

/** @typedef {import('./view-state.mjs').View} View */

// The pill floats just above the composer. It shows only while the end is further below than that, so what it
// floats over is never the working rows or the end of the last message (#91).
export const PILL_ROOM = 48;
/** @param {View} v @param {Element | null} s */
export function showJump(v, s) {
  const n = s && gapOf(s) > PILL_ROOM ? v.unseen : 0;
  if (n !== v.shown) v.jump?.((v.shown = n));
}
/** @param {View} v */
export function seen(v) {
  v.unseen = 0;
  showJump(v, null);
}
/**
 * A reply arrived below while you read higher up. It only moves the end further away, so it counts on the pill now,
 * written before the frame lays the page out. Reading the gap to the end here would lay the page out first, once a
 * reply (#1047), and writing the pill after the frame’s layout would lay it out again. follow() measures the gap after
 * the frame’s layout, and hides the pill if the end is nearer than it.
 * @param {View} v
 */
export function countUnseen(v) {
  v.unseen++;
  if (v.unseen !== v.shown) v.jump?.((v.shown = v.unseen));
}
