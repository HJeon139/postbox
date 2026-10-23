// The right pane’s width beside the conversation (#197, #7). The conversation column keeps a minimum, at which a
// reply’s text and the composer stay usable (architecture.md §14). To keep it, the rail hides first, while the pane
// is open; then the pane gives up width; and where even the pane’s own minimum doesn’t fit, its view opens full
// screen instead (pane.mjs). What’s open stays in the address, so a wider window puts the pane back beside the
// conversation.

import { railHidden, setRailAuto } from './rail-collapse.mjs';

/** The conversation column’s narrowest, with its padding (architecture.md §14). */
export const COL_MIN = 640;
/** The pane’s narrowest, and its width until it’s resized. */
export const PANE_MIN = 320;
export const PANE_W = 440;
const RAIL_W = 248;
/** Below this width the pane covers the conversation instead (workbench.css). */
const NARROW = 768;

/**
 * How the pane sits in a window win px wide when it wants want px: its width, the most it can take, whether the
 * rail hides to make room (#7), and whether the view opens full screen, since even the pane’s minimum would squeeze
 * the column.
 * @param {number} win
 * @param {number} want
 * @param {{ rail?: boolean, keep?: boolean }} [opts]  rail: whether the person shows the rail; keep: they showed it
 *   again while the pane was open, so it stays
 */
export function fit(win, want, { rail = !railHidden(), keep = false } = {}) {
  const room = (withRail) => win - (withRail ? RAIL_W : 0) - COL_MIN;
  const max = room(rail && keep);
  if (win < NARROW || max < PANE_MIN) return { width: want, max: want, collapse: false, full: win >= NARROW };
  const width = Math.min(want, max);
  return { width, max, collapse: rail && !keep && width > room(true), full: false };
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
  let keep = false;
  /** Sets the width and the rail; whether the pane started or stopped having to open full screen. */
  function update() {
    if (el.hidden) keep = false;
    const f = fit(innerWidth, want, { keep });
    el.parentElement?.style.setProperty('--pane-w', `${f.width}px`);
    setRailAuto(!el.hidden && f.collapse);
    const was = cramped;
    cramped = !el.hidden && f.full;
    return was !== cramped;
  }
  const refit = (/** @type {Event} */ e) => {
    // The person showed the rail while the pane had hidden it: it stays, and the pane makes do with what’s left.
    if (/** @type {CustomEvent} */ (e).detail?.keep) keep = true;
    if (update()) onCramped();
  };
  addEventListener('resize', refit);
  addEventListener('pb-rail', refit);
  return {
    update,
    /** Whether the pane’s view has to open full screen in this window. */
    cramped: () => fit(innerWidth, want, { keep }).full,
    destroy() {
      removeEventListener('resize', refit);
      removeEventListener('pb-rail', refit);
    },
  };
}
