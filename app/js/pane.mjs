// The right pane beside a conversation: its side views, a thread and its Work (#132), alone or together. Together
// they split it, Work above and the thread below, so the thread’s composer stays at the foot of the window beside the
// conversation’s; the divider between them moves by mouse or keyboard, and its place is kept in this browser. What’s
// open comes from the address (route() in ui.mjs), so a reload restores it, and Work expands from here to the whole
// window.

import { client } from './client.mjs';
import { h } from './dom.mjs';
import { mountSidePanel } from './thread.mjs';
import { closeWork, openDialog } from './ui.mjs';
import { mountWork, mountWorkPane } from './work.mjs';

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
  /** @type {{ key: string, view: any, dlg: any } | null} */
  let full = null;
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

  // ── Expanded ──────────────────────────────────────────────────────────────────────────
  // The whole Work view over the window, as a dialog: Escape or Close shrinks it back to the pane, and focus returns
  // to what opened it (Expand when the address opened it, as on a reload).

  function openFull(r, key) {
    const view = mountWork(convId, { turnId: r.turn, at: r.at });
    if (full) {
      full.view.destroy();
      full.dlg.dialog.querySelector('.d-body').replaceChildren(view.el);
      full.key = key;
      full.view = view;
      view.target().focus();
      return;
    }
    const t = client.state.threads[convId];
    const mine = { key, view, dlg: /** @type {any} */ (null) };
    full = mine;
    mine.dlg = openDialog({
      title: 'Work',
      sub: t?.title ?? '',
      body: view.el,
      size: 'full',
      initialFocus: () => mine.view.target(),
      onClose: () => {
        mine.view.destroy();
        // Closed from the dialog (Escape, Close): shrink back to the pane. Closed by the address: it’s already there.
        if (full !== mine) return;
        full = null;
        // After the dialog has put focus back where it came from, if it had nowhere to put it.
        queueMicrotask(() => {
          if (!document.activeElement || document.activeElement === document.body) document.getElementById('work-expand')?.focus();
        });
        closeWork(convId, { shrink: true });
      },
    });
  }
  function closeFull() {
    if (!full) return;
    const was = full;
    full = null;
    was.dlg.close();
  }

  // ── What’s open ───────────────────────────────────────────────────────────────────────

  function set(r, { again = false } = {}) {
    const had = el.contains(document.activeElement);
    // The thread.
    const sideId = r.sideId ?? null;
    if ((thread?.id ?? null) !== sideId) {
      const next = sideId ? mountSidePanel(convId, sideId) : null;
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

    // Expanded, on a turn or at an item.
    if (r.full) {
      const key = `${r.turn ?? ''}|${r.at ?? ''}`;
      if (!full || full.key !== key) openFull(r, key);
    } else closeFull();
    // From a turn’s line: the pane scrolls to that turn, and focus goes to it.
    if (work && !r.full) {
      if (r.turn && (r.turn !== lastTurn || again)) work.showTurn(r.turn, { focus: true });
      else if (again && !r.turn) work.focus();
      lastTurn = r.turn;
    }
  }

  return {
    el,
    set,
    destroy() {
      closeFull();
      thread?.view.destroy();
      work?.destroy();
    },
  };
}
