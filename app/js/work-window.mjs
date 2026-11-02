// Long lists in full-screen Work, drawn a window at a time (#618). A day’s conversation has thousands of commands, and
// drawing each as an item that opens cost a second of layout on every change to the ledger. A list draws STEP items,
// its newest or those around the item Work was opened at, with a button on each side that draws STEP more. A window
// at the newest end of a list grows with what arrives, and one around the item Work opened at moves with it when the
// list is sorted again (git’s answer flags files, which go first).

import { h, plural } from './dom.mjs';

export const STEP = 50;

/**
 * The windows of one view, which keep what you showed across its repaints. reset() forgets them, for when the
 * view’s lists change for another reason than the ledger’s, such as one agent’s work in place of all of it.
 * @param {() => void} paint  the view’s repaint @param {string|null} at  the item the view opened at
 */
export function windows(paint, at) {
  /** @type {Map<string, { lo: number, hi: number, len: number, i: number }>} */
  const shown = new Map();
  /**
   * The items of a list to draw, and the buttons before and after them that draw more, or null for a side with none.
   * @template T
   * @param {string} key  the list’s name in the view, which the buttons’ ids carry
   * @param {T[]} list
   * @param {{ idOf: (x: T) => string, elId: (x: T) => string, newest: 'start'|'end', before: string, after: string }} o
   *   idOf: an item’s id, as the view’s at names it; elId: the id of the element that takes focus for it; newest: where
   *   the newest items are, the end of a list in the order they came, or its start; before, after: what each button
   *   shows more of, singular (“earlier command”)
   * @returns {{ items: T[], above: HTMLElement | null, below: HTMLElement | null }}
   */
  const win = (key, list, { idOf, elId, newest, before, after }) => {
    const len = list.length;
    let w = shown.get(key);
    if (!w) {
      const i = at ? list.findIndex((x) => idOf(x) === at) : -1;
      const centre = i >= 0 ? i : newest === 'end' ? len - 1 : 0;
      const lo = Math.max(0, Math.min(centre - STEP / 2, len - STEP));
      w = { lo, hi: lo + STEP, len, i };
      shown.set(key, w);
    }
    // Where the item it opened at is now: the window moves by as much (#618).
    const i = w.i < 0 ? -1 : list.findIndex((x) => idOf(x) === at);
    if (i >= 0) Object.assign(w, { lo: w.lo + i - w.i, hi: w.hi + i - w.i, i });
    if (newest === 'end' && w.hi >= w.len) w.hi = len; // it was at the newest, so it takes in what arrived
    w.len = len;
    // A list that got shorter still draws a full window, from no further in than its last STEP.
    const lo = Math.max(0, Math.min(w.lo, len - STEP));
    const hi = Math.min(len, Math.max(w.hi, lo + STEP));
    const button = (side, n, noun, first, grow) =>
      h(
        'button.btn.sm.ghost.work-more',
        {
          type: 'button',
          id: `work-${side}-${key}`,
          onclick: () => {
            grow(/** @type {{ lo: number, hi: number, len: number, i: number }} */ (w));
            paint();
            // Focus goes to the first item it drew, in reading order.
            document.getElementById(elId(first))?.focus();
          },
        },
        `Show ${plural(n, noun)}`,
        h('span.dim', ` · ${(side === 'above' ? lo : len - hi).toLocaleString('en-US')} not shown`),
      );
    const up = Math.min(STEP, lo);
    const down = Math.min(STEP, len - hi);
    return {
      items: list.slice(lo, hi),
      above: up ? button('above', up, before, list[lo - up], (x) => Object.assign(x, { lo: lo - up })) : null,
      below: down ? button('below', down, after, list[hi], (x) => Object.assign(x, { hi: hi + down })) : null,
    };
  };
  return Object.assign(win, { reset: () => shown.clear() });
}
