// The right pane’s width beside the conversation (#197). The conversation column keeps a minimum, at which a
// reply’s text and the composer stay usable (architecture.md §14). The pane gives up width to keep it, and where
// even the pane’s own minimum doesn’t fit, its view opens full screen instead (pane.mjs). What’s open stays in the
// address, so a wider window puts the pane back beside the conversation.

import { railHidden } from './rail-collapse.mjs';

/** The conversation column’s narrowest, with its padding (architecture.md §14). */
export const COL_MIN = 640;
/** The pane’s narrowest, and its width until it’s resized. */
export const PANE_MIN = 320;
export const PANE_W = 440;
const RAIL_W = 248;
/** Below this width the pane covers the conversation instead (workbench.css). */
const NARROW = 768;

/**
 * How the pane sits in a window win px wide when it wants want px: its width, the most it can take, and whether
 * it opens full screen, since even its minimum would squeeze the column.
 * @param {number} win
 * @param {number} want
 * @param {{ rail?: boolean }} [opts]  rail: whether the rail shows
 */
export function fit(win, want, { rail = !railHidden() } = {}) {
  const max = win - (rail ? RAIL_W : 0) - COL_MIN;
  if (win < NARROW || max < PANE_MIN) return { width: want, max: want, full: win >= NARROW };
  return { width: Math.min(want, max), max, full: false };
}

/** Whether the pane fits beside the conversation in this window. */
export const besideFits = () => innerWidth >= NARROW && !fit(innerWidth, PANE_MIN).full;

/**
 * Keeps the pane’s width to the rule as the window and the rail change. onCramped runs when the pane starts or stops
 * having to open full screen.
 * @param {HTMLElement} el  the pane
 * @param {() => void} onCramped
 */
export function mountWidth(el, onCramped) {
  const want = PANE_W;
  let cramped = false;
  /** Sets the width; whether the pane started or stopped having to open full screen. */
  function update() {
    const f = fit(innerWidth, want);
    el.parentElement?.style.setProperty('--pane-w', `${f.width}px`);
    const was = cramped;
    cramped = !el.hidden && f.full;
    return was !== cramped;
  }
  const refit = () => {
    if (update()) onCramped();
  };
  addEventListener('resize', refit);
  addEventListener('pb-rail', refit);
  return {
    update,
    /** Whether the pane’s view has to open full screen in this window. */
    cramped: () => fit(innerWidth, want).full,
    destroy() {
      removeEventListener('resize', refit);
      removeEventListener('pb-rail', refit);
    },
  };
}
