// The divider between Work and the thread when both are open in the right pane (pane.mjs). Its place is kept in
// this browser.

import { h } from './dom.mjs';

const SPLIT_KEY = 'pb-pane-split';
const MIN = 20;
const MAX = 80;
const clamp = (n) => Math.min(MAX, Math.max(MIN, Math.round(n)));
function savedSplit() {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY));
    return n ? clamp(n) : 50;
  } catch {
    return 50;
  }
}

/**
 * @param {HTMLElement} el  the pane, which it sets the split on
 * @returns {HTMLElement}
 */
export function mountDivider(el) {
  let split = savedSplit();

  // ── The divider ───────────────────────────────────────────────────────────────────────
  // A window splitter: ↑ and ↓ move it, Home and End take it to either end, and a drag moves it too.
  const divider = h('div.rp-divider', {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'horizontal',
    'aria-label': 'Resize Work and the thread',
    'aria-controls': 'work-pane',
    'aria-valuemin': String(MIN),
    'aria-valuemax': String(MAX),
    hidden: true,
    onkeydown: (e) => {
      const to = { ArrowUp: split - 5, ArrowDown: split + 5, PageUp: split - 15, PageDown: split + 15, Home: MIN, End: MAX }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      setSplit(to, true);
    },
    onpointerdown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const b = el.getBoundingClientRect();
        setSplit(((ev.clientY - b.top) / b.height) * 100, false);
      };
      const up = () => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
        setSplit(split, true);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
    },
  });
  function setSplit(n, save) {
    split = clamp(n);
    el.style.setProperty('--split-a', `${split}fr`);
    el.style.setProperty('--split-b', `${100 - split}fr`);
    divider.setAttribute('aria-valuenow', String(split));
    divider.setAttribute('aria-valuetext', `Work ${split}%, thread ${100 - split}%`);
    if (save)
      try {
        localStorage.setItem(SPLIT_KEY, String(split));
      } catch {}
  }
  setSplit(split, false);
  return divider;
}
