// The right pane beside a conversation: its side views, a thread and its Work (#132), alone or together. Together
// they split it, Work above and the thread below, so the thread’s composer stays at the foot of the window beside the
// conversation’s; the divider between them moves by mouse or keyboard, and its place is kept in this browser. What’s
// open comes from the address (route() in ui.mjs), so a reload restores it, and either view goes full screen from
// here: one contract for a pane view, a compact form in the pane and a full form over the window. Where the window
// has no room for the pane beside the conversation, the view opened last opens full screen instead (#197).

import { h, icon } from './dom.mjs';
import { mountDivider } from './pane-split.mjs';
import { mountWidth } from './pane-width.mjs';
import { mountSidePanel } from './thread.mjs';
import { navigate, paneHref, rememberWork, route, setPaneFull } from './ui.mjs';
import { mountWorkPane } from './work.mjs';

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

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
  /** The view opened last, which opens full screen where the pane can’t sit beside the conversation. */
  let latest = null;

  const divider = mountDivider(el);
  const width = mountWidth(el, () => set(route()));
  /** Back to the conversation, where it has no room for the pane beside it: what’s open there closes. */
  const closeAll = () => {
    rememberWork(convId, false);
    navigate(paneHref(convId), { replace: true });
  };

  // ── Full screen ───────────────────────────────────────────────────────────────────────
  // Either view goes full screen with the app frames’ icon (#45) in its head. It isn’t moved or rebuilt: the view
  // itself is fixed over the window (class pane-full), so a thread keeps its draft, where it was scrolled, and a
  // reply that’s streaming; Work swaps its compact form for its full one. It’s a dialog while it lasts: Tab stays in
  // it, and Escape or the icon (now “Exit full screen”) brings it back to the pane, with focus on what opened it, or,
  // where the window has no room for the pane, back to the conversation.

  /** @type {'work' | 'thread' | null} */
  let fullKind = null;
  /** What had focus when full screen began, found again by id if the pane repainted it. */
  let opener = null;
  const viewOf = (kind) => (kind === 'work' ? work : kind === 'thread' ? thread?.view : null);
  const titleOf = (kind) => (kind === 'work' ? 'wp-title' : 'sp-title');

  const onKey = (e) => {
    const v = viewOf(fullKind);
    if (!v || e.defaultPrevented) return;
    // A menu or dialog over it takes its own keys (a dialog’s never get here).
    if (e.target instanceof Element && e.target.closest('.menu')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (width.cramped()) closeAll();
      else setPaneFull(null);
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
    // Before Work swaps its body, which takes the item you chose with it.
    const from = document.activeElement;
    if (was !== kind) opener = from && from !== document.body ? { el: from, id: from.id } : null;
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
    // Focus goes back to what opened it: the icon, or the item you chose in the pane.
    const back = opener?.el.isConnected ? opener.el : opener?.id ? document.getElementById(opener.id) : null;
    opener = null;
    if (focus) (back instanceof HTMLElement && back.offsetParent ? back : v.fullBtn).focus();
  }
  /** The icon in a view’s head: full screen, or back to the pane. */
  const fullToggle = (kind) => () => (fullKind === kind && width.cramped() ? closeAll() : setPaneFull(fullKind === kind ? null : kind));

  // ── What’s open ───────────────────────────────────────────────────────────────────────

  function set(r, { again = false } = {}) {
    const had = el.contains(document.activeElement);
    const closing = { work: !!work && !r.work, thread: thread && thread.id !== (r.sideId ?? null) ? thread.id : null };
    const sideId = r.sideId ?? null;
    if (sideId && sideId !== thread?.id) latest = 'thread';
    else if (r.work && !work) latest = 'work';
    // What’s full screen: what the address says, else, where the pane has no room, the view opened last (#197).
    const cover = sideId && (!r.work || latest === 'thread') ? 'thread' : r.work ? 'work' : null;
    const full = r.full ?? (width.cramped() ? cover : null);
    // A view leaving full screen goes back first, so it’s in the pane when it closes or another view goes full.
    // Focus goes back to its icon only if it stays open.
    const stays = fullKind === 'thread' ? thread?.id === sideId : !!r.work;
    if (fullKind && (fullKind !== full || !stays)) leaveFull({ focus: stays && !full });
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
    width.update();

    // Focus lost with a view that closed goes to what opens it: Work’s button, a thread’s line, else the conversation.
    // Focus given back outside the pane, as to the turn’s list row that opened Work full screen (#195), stays there.
    if (had && (!document.activeElement || document.activeElement === document.body)) {
      const button = closing.work ? document.getElementById('work-button') : null;
      const link = closing.thread ? document.querySelector(`#main a[href*="/side/${CSS.escape(closing.thread)}"]`) : null;
      const to = [button, link].find((x) => x instanceof HTMLElement && x.offsetParent);
      /** @type {HTMLElement | null} */ (to ?? document.getElementById('main'))?.focus();
    }

    // Full screen: Work on a turn or at an item, or the thread.
    if (full && viewOf(full)) enterFull(full, r);
    // From a turn’s line: the pane scrolls to that turn, and focus goes to it.
    if (work && full !== 'work') {
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
      width.destroy();
      thread?.view.destroy();
      work?.destroy();
    },
  };
}
