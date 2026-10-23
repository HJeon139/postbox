// The right pane’s width beside the conversation (#197, #7, #86). The conversation column keeps a minimum, at which a
// reply’s text and the composer stay usable (architecture.md §14). To keep it, the rail hides first, while the pane
// is open; then the pane gives up width; and where even the pane’s own minimum doesn’t fit, its view opens full
// screen instead (pane.mjs). What’s open stays in the address, so a wider window puts the pane back beside the
// conversation. A handle on the pane’s left edge changes its width within the same rule, and the width is kept in
// this browser, like the divider’s place.

import { h } from './dom.mjs';
import { railHidden, setRailAuto } from './rail-collapse.mjs';

/** The conversation column’s narrowest, with its padding (architecture.md §14). */
export const COL_MIN = 640;
/** The pane’s narrowest, and its width until it’s resized. */
export const PANE_MIN = 320;
export const PANE_W = 440;
const WIDTH_KEY = 'pb-pane-w';
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

function savedWidth() {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n >= PANE_MIN ? Math.round(n) : PANE_W;
  } catch {
    return PANE_W;
  }
}

/**
 * The handle on the pane’s left edge (#86), a window splitter: ← and → move it, Home and End take it to either end,
 * a drag moves it, and a double-click puts the pane back at its first width.
 * @param {{ now: () => { width: number, max: number }, to: (n: number, save: boolean) => void }} pane
 */
function mountHandle({ now, to }) {
  const handle = h('div.rp-handle', {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the pane',
    'aria-valuemin': String(PANE_MIN),
    onkeydown: (e) => {
      const { width, max } = now();
      const n = { ArrowLeft: width + 16, ArrowRight: width - 16, PageUp: width + 64, PageDown: width - 64, Home: PANE_MIN, End: max }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      to(n, true);
    },
    ondblclick: () => to(PANE_W, true),
    onpointerdown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => to(innerWidth - ev.clientX, false);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        to(now().width, true);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
  });
  return handle;
}

/**
 * Keeps the pane’s width to the rule as the window and the rail change. onCramped runs when the pane starts or stops
 * having to open full screen.
 * @param {HTMLElement} el  the pane
 * @param {() => void} onCramped
 */
export function mountWidth(el, onCramped) {
  let want = savedWidth();
  let cramped = false;
  let keep = false;
  let last = fit(innerWidth, want);
  const handle = mountHandle({
    now: () => last,
    to: (n, save) => {
      want = Math.round(Math.min(Math.max(n, PANE_MIN), last.max));
      if (save)
        try {
          localStorage.setItem(WIDTH_KEY, String(want));
        } catch {}
      if (update()) onCramped();
    },
  });
  el.prepend(handle);
  /** Sets the width and the rail; whether the pane started or stopped having to open full screen. */
  function update() {
    if (el.hidden) keep = false;
    const f = fit(innerWidth, want, { keep });
    last = f;
    el.parentElement?.style.setProperty('--pane-w', `${f.width}px`);
    handle.setAttribute('aria-valuenow', String(f.width));
    handle.setAttribute('aria-valuemax', String(f.max));
    handle.setAttribute('aria-valuetext', `${f.width} px wide`);
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
    handle,
    update,
    /** Whether the pane’s view has to open full screen in this window. */
    cramped: () => fit(innerWidth, want, { keep }).full,
    destroy() {
      removeEventListener('resize', refit);
      removeEventListener('pb-rail', refit);
    },
  };
}
