// The right pane beside a conversation: its side views, a thread and its Work (#132), alone or together. Together
// they split it, Work above and the thread below, so the thread’s composer stays at the foot of the window beside the
// conversation’s; the divider between them moves by mouse or keyboard, and its place is kept in this browser. What’s
// open comes from the address (route() in ui.mjs), so a reload restores it, and either view goes full screen from
// here: one contract for a pane view, a compact form in the pane and a full form over the window.

import { h, icon } from './dom.mjs';
import { mountSidePanel } from './thread.mjs';
import { setPaneFull } from './ui.mjs';
import { mountWorkPane } from './work.mjs';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
 * @param {string} convId  the conversation
 * @returns {{ el: HTMLElement, set: (r: any, opts?: { again?: boolean }) => void, destroy: () => void }}
 */
export function mountPane(convId) {
  const el = h('div.rpane', { hidden: true });
  /** @type {{ id: string, view: any } | null} */
  let thread = null;
  /** @type {any} */
  let work = null;
  let lastTurn = null;
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

  // ── Full screen ───────────────────────────────────────────────────────────────────────
  // Either view goes full screen with the app frames’ icon (#45) in its head. It isn’t moved or rebuilt: the view
  // itself is fixed over the window (class pane-full), so a thread keeps its draft, where it was scrolled, and a
  // reply that’s streaming; Work swaps its compact form for its full one. It’s a dialog while it lasts: Tab stays in
  // it, and Escape or the icon (now “Exit full screen”) brings it back to the pane, with focus on the icon.

  /** @type {'work' | 'thread' | null} */
  let fullKind = null;
  const viewOf = (kind) => (kind === 'work' ? work : kind === 'thread' ? thread?.view : null);
  const titleOf = (kind) => (kind === 'work' ? 'wp-title' : 'sp-title');

  const onKey = (e) => {
    const v = viewOf(fullKind);
    if (!v || e.defaultPrevented) return;
    // A menu or dialog over it takes its own keys.
    if (document.querySelector('body > .backdrop, .menu')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      setPaneFull(null);
    }
    if (e.key === 'Tab') {
      const f = [...v.el.querySelectorAll(FOCUSABLE)].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === f.at(-1)) {
        e.preventDefault();
        f[0].focus();
      }
    }
  };

  /** @param {'work' | 'thread'} kind */
  function enterFull(kind, r) {
    const v = viewOf(kind);
    if (!v) return;
    const was = fullKind;
    if (was && was !== kind) leaveFull({ focus: false });
    const to = kind === 'work' ? work.setFull({ turn: r.turn, at: r.at }) : v.fullBtn;
    if (was === kind) {
      if (kind === 'work') to.focus();
      return;
    }
    fullKind = kind;
    v.el.classList.add('pane-full');
    v.el.setAttribute('role', 'dialog');
    v.el.setAttribute('aria-modal', 'true');
    v.el.setAttribute('aria-labelledby', titleOf(kind));
    v.fullBtn.setAttribute('aria-label', 'Exit full screen');
    document.addEventListener('keydown', onKey);
    to.focus();
  }
  function leaveFull({ focus = true } = {}) {
    const v = viewOf(fullKind);
    const kind = fullKind;
    fullKind = null;
    document.removeEventListener('keydown', onKey);
    if (!v) return;
    v.el.classList.remove('pane-full');
    for (const a of ['role', 'aria-modal']) v.el.removeAttribute(a);
    v.fullBtn.setAttribute('aria-label', 'Full screen');
    if (kind === 'work') work.setFull(null);
    if (focus) v.fullBtn.focus();
  }
  /** The icon in a view’s head: full screen, or back to the pane. */
  const fullToggle = (kind) => () => setPaneFull(fullKind === kind ? null : kind);

  // ── What’s open ───────────────────────────────────────────────────────────────────────

  function set(r, { again = false } = {}) {
    const had = el.contains(document.activeElement);
    const sideId = r.sideId ?? null;
    // A view leaving full screen goes back first, so it’s in the pane when it closes or another view goes full.
    // Focus goes back to its icon only if it stays open.
    const stays = fullKind === 'thread' ? thread?.id === sideId : !!r.work;
    if (fullKind && (fullKind !== r.full || !stays)) leaveFull({ focus: stays && !r.full });
    // The thread.
    if ((thread?.id ?? null) !== sideId) {
      const next = sideId ? mountSidePanel(convId, sideId) : null;
      if (next) {
        // Its head gets the full-screen icon, before its close button.
        const head = next.el.querySelector('.sp-head');
        const fullBtn = h(
          'button.btn.icon.sm',
          { type: 'button', id: 'thread-full', 'aria-label': 'Full screen', onclick: fullToggle('thread') },
          icon('expand'),
        );
        head?.insertBefore(fullBtn, head.lastElementChild);
        next.fullBtn = fullBtn;
      }
      if (thread) {
        thread.view.destroy();
        if (next) thread.view.el.replaceWith(next.el);
        else thread.view.el.remove();
      } else if (next) el.append(next.el);
      thread = next ? { id: sideId, view: next } : null;
    }
    // Work.
    if (r.work && !work) {
      work = mountWorkPane(convId);
      work.fullBtn.onclick = fullToggle('work');
      el.prepend(work.el);
    } else if (!r.work && work) {
      work.destroy();
      work.el.remove();
      work = null;
      lastTurn = null;
    }
    const both = !!(work && thread);
    divider.hidden = !both;
    if (both && !divider.isConnected) work.el.after(divider);
    if (!both) divider.remove();
    el.classList.toggle('split', both);
    el.hidden = !work && !thread;
    el.parentElement?.classList.toggle('has-panel', !el.hidden);

    // Focus that was in a view that closed goes to what opened it: the top bar’s Work button, or the conversation.
    if (had && !el.contains(document.activeElement)) {
      const button = document.getElementById('work-button');
      (button?.offsetParent ? button : document.getElementById('main'))?.focus();
    }

    // Full screen: Work on a turn or at an item, or the thread.
    if (r.full && viewOf(r.full)) enterFull(r.full, r);
    // From a turn’s line: the pane scrolls to that turn, and focus goes to it.
    if (work && r.full !== 'work') {
      if (r.turn && (r.turn !== lastTurn || again)) work.showTurn(r.turn, { focus: true });
      else if (again && !r.turn) work.focus();
      lastTurn = r.turn;
    }
  }

  return {
    el,
    set,
    destroy() {
      leaveFull({ focus: false });
      thread?.view.destroy();
      work?.destroy();
    },
  };
}
