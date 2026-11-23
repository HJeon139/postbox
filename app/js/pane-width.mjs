// The right pane’s width beside the conversation (#197, #7, #86). The conversation column keeps a minimum, at which a
// reply’s text and the composer stay usable (designs/architecture/front-end.md, “Room for the conversation”). To keep it, the rail hides first, while the pane
// is open; then the pane gives up width; and where even the pane’s own minimum doesn’t fit, its view opens full
// screen instead (pane.mjs). What’s open stays in the address, so a wider window puts the pane back beside the
// conversation. A handle on the pane’s left edge changes its width within the same rule, and the width is kept in
// this browser, like the divider’s place.

import { h } from './dom.mjs';
import { railHidden, setRailAuto } from './rail-collapse.mjs';

/** The conversation column’s narrowest, with its padding (designs/architecture/front-end.md, “Room for the conversation”). */
export const COL_MIN = 640;
/** The pane’s narrowest, and its width until it’s resized. */
export const PANE_MIN = 320;
export const PANE_W = 440;
const WIDTH_KEY = 'pb-pane-w';
const RAIL_W = 248;
/** Below this width the pane covers the conversation instead (workbench.css). */
const NARROW = 768;
/**
 * The width the column and the pane share: the window’s, less a classic scroll bar. It’s kept while the window’s width
 * stays the same, since reading it lays out whatever is pending, the whole transcript after a change (#619). The
 * window’s own width is checked on every read, as fit() reads it anyway: a resize event comes only at the next frame,
 * and a pane opened before it would fit the old window.
 * @type {{ window: number, width: number } | null}
 */
let kept = null;
const roomW = () => {
  if (kept?.window !== innerWidth) kept = { window: innerWidth, width: document.documentElement.clientWidth };
  return kept.width;
};
// A classic scroll bar showing or going changes the root’s width without a resize. The root grows taller with every
// new item, so only a change of width forgets it: the root has no padding, so its box is as wide as clientWidth. The
// observer reports after the layout that changed it, so a pane that opened in the meantime kept the old width: an open
// pane refits on pb-room-width, as it does on pb-rail.
let rootBox = -1;
if (typeof ResizeObserver === 'function')
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === rootBox) return;
    const first = rootBox < 0;
    rootBox = entry.contentRect.width;
    kept = null;
    if (!first) dispatchEvent(new Event('pb-room-width'));
  }).observe(document.documentElement);

/**
 * How the pane sits in win px when it wants want px: its width, the most it can take, whether the rail hides to make
 * room (#7) and whether it could show at all, and whether the view opens full screen, since even the pane’s minimum
 * would squeeze the column.
 * @param {number} win
 * @param {number} want
 * @param {{ rail?: boolean, keep?: boolean, narrow?: boolean }} [opts]  rail: whether the person shows the rail;
 *   keep: they showed it again while the pane was open, so it stays; narrow: the window is under 768 px
 */
export function fit(win, want, { rail = !railHidden(), keep = false, narrow = innerWidth < NARROW } = {}) {
  const room = (withRail) => win - (withRail ? RAIL_W : 0) - COL_MIN;
  // Where even the pane’s minimum doesn’t fit beside the rail, the rail stays hidden: shown, it would only push the
  // pane full screen over it.
  const railFits = room(true) >= PANE_MIN;
  keep &&= railFits;
  const max = room(rail && keep);
  if (narrow || max < PANE_MIN) return { width: want, max: want, collapse: false, railFits, full: !narrow };
  const width = Math.min(want, max);
  return { width, max, collapse: rail && !keep && width > room(true), railFits, full: false };
}

/** Whether the pane fits beside the conversation in this window. */
export const besideFits = () => innerWidth >= NARROW && !fit(roomW(), PANE_MIN).full;

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
    'aria-controls': 'right-pane',
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
      const move = (ev) => to(roomW() - ev.clientX, false);
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
 * Sets the pane’s width on .app and on each reader itself, the pane and the column beside it, not only on .app for them
 * to inherit: WebKit doesn’t restyle a child that inherits a non-inheriting property when its parent’s changes, so
 * Safari’s column kept its old width as the pane grew, and its text ran under the pane (#1465).
 * @param {HTMLElement} el  the pane @param {number} width
 */
function setWidth(el, width) {
  const app = el.parentElement;
  for (const reader of [app, el, app?.querySelector(':scope > .main')]) reader?.style.setProperty('--pane-w', `${width}px`);
}

/**
 * How far toasts sit from the window’s right edge, past a pane beside the conversation (#1472). #toasts is the body’s,
 * outside .app, so it’s told here rather than reading .app’s class. @param {number} width  the pane’s, or 0
 */
function asideToasts(width) {
  document.getElementById('toasts')?.style.setProperty('--pane-aside', `${width}px`);
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
  let last = fit(roomW(), want);
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
    const f = fit(roomW(), want, { keep });
    last = f;
    setWidth(el, f.width);
    handle.setAttribute('aria-valuenow', String(f.width));
    handle.setAttribute('aria-valuemax', String(f.max));
    handle.setAttribute('aria-valuetext', `${f.width} px wide`);
    setRailAuto(!el.hidden && f.collapse, !el.hidden && !f.railFits);
    const was = cramped;
    cramped = !el.hidden && f.full;
    // Covering the conversation, the pane takes none of its width: the column behind keeps its own, so its composer has
    // room for its placeholder and its quota line when the pane closes (#442), rather than being squeezed to 80 px.
    el.parentElement?.classList.toggle('pane-covers', cramped);
    asideToasts(!el.hidden && !cramped ? f.width : 0);
    return was !== cramped;
  }
  const refit = (/** @type {Event} */ e) => {
    // The person showed the rail while the pane had hidden it: it stays, and the pane makes do with what’s left.
    if (/** @type {CustomEvent} */ (e).detail?.keep) keep = true;
    if (update()) onCramped();
  };
  addEventListener('resize', refit);
  addEventListener('pb-rail', refit);
  addEventListener('pb-room-width', refit);
  return {
    handle,
    update,
    /** Whether the pane’s view has to open full screen in this window. */
    cramped: () => fit(roomW(), want, { keep }).full,
    destroy() {
      // Before the next view builds its top bar, which reads whether the rail shows.
      setRailAuto(false);
      asideToasts(0);
      removeEventListener('resize', refit);
      removeEventListener('pb-rail', refit);
      removeEventListener('pb-room-width', refit);
    },
  };
}
