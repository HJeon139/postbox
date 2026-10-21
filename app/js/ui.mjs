// Shared UI pieces: navigation, toasts, the live region, the tab title and favicon, dialogs, menus,
// and hover cards for citations and glossary terms.

import { renderMarkdown } from '/shared/markdown.mjs';
import { finishedSentences } from '/shared/text.mjs';
import { $, $$, h, icon, trusted } from './dom.mjs';

// ── Navigation ──────────────────────────────────────────────────────────────────────────
// Routes: #/ (overview), #/t/<threadId>, #/t/<threadId>/side/<sideThreadId>

export function route() {
  const m = location.hash.match(/^#\/t\/([^/]+)(?:\/side\/([^/]+))?/);
  if (m) return { view: 'thread', threadId: m[1], sideId: m[2] ?? null };
  const p = location.hash.match(/^#\/p\/([^/]+)(\/threads)?/);
  if (p) return { view: p[2] ? 'threads' : 'project', projectId: p[1] };
  return { view: 'overview' };
}
export function navigate(hash, { replace = false } = {}) {
  if (location.hash === hash) return;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

// ── Toasts ──────────────────────────────────────────────────────────────────────────────

export function toast({ title, text = '', ring = null, action = null, level = 'info', timeout = 8000 }) {
  const box = $('#toasts');
  const close = () => {
    el.remove();
  };
  const el = h(
    'div.toast',
    { class: level === 'info' ? 'plain' : '', role: level === 'blocking' ? 'alert' : 'status' },
    ring,
    h('div.t-body', h('b', title), text ? h('span.small', text) : null),
    action
      ? h(
          'button.btn.sm',
          {
            onclick: () => {
              close();
              action.run();
            },
          },
          action.label,
        )
      : null,
    h('button.btn.icon.sm.ghost', { 'aria-label': 'Dismiss', onclick: close }, icon('x')),
  );
  box.prepend(el);
  while (box.children.length > 3) box.lastChild.remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}

/** Undo toast with a visible countdown. */
export function undoToast({ text, until, onUndo }) {
  // Each deletion keeps its own Undo; only the oldest goes when a fourth arrives.
  const box = $('#toasts-bottom');
  while (box.children.length >= 3) box.firstElementChild.remove();
  const bar = h('i', { style: { width: '100%' } });
  const label = h('span');
  const el = h(
    'div.toast.plain',
    { role: 'status' },
    icon('trash', 'dim'),
    h('div.t-body', h('span', text), h('div.countdown', { 'aria-hidden': 'true' }, bar)),
    h(
      'button.btn.sm',
      {
        onclick: () => {
          stop();
          el.remove();
          onUndo();
        },
      },
      'Undo',
      label,
    ),
  );
  box.append(el);
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    bar.style.width = `${(left / 10000) * 100}%`;
    label.textContent = ` · ${Math.ceil(left / 1000)} s`;
    if (!left) {
      stop();
      el.remove();
    }
  };
  const t = setInterval(tick, 250);
  const stop = () => clearInterval(t);
  tick();
}

// ── Screen-reader announcements ────────────────────────────────────────────────────────

const spoken = new Map(); // itemId → characters already announced
export function announceStreaming(itemId, text, done, who) {
  const prev = spoken.get(itemId) ?? 0;
  const r = finishedSentences(text, prev, done);
  spoken.set(itemId, r.spoken);
  if (r.sentences.length) say(`${prev === 0 && who ? who + ': ' : ''}${r.sentences.join(' ')}`);
}
export function say(text, urgent = false) {
  const el = $(urgent ? '#live-urgent' : '#live');
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, 30);
}

// ── Tab title and favicon ──────────────────────────────────────────────────────────────

let lastBadge = -1;
export function setAttention(count, label) {
  document.title = `${count ? `(${count}) ` : ''}${label} · Postbox`;
  if (count === lastBadge) return;
  lastBadge = count;
  // lint-allow tokens: a favicon is a data URL, which can’t read CSS variables; these are the brand mark’s fixed colors.
  const dot = count ? '<circle cx="25" cy="7" r="6.5" fill="#e23b2e" stroke="#15110e" stroke-width="2"/>' : '';
  // lint-allow tokens: as above.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="3" width="26" height="26" rx="7" fill="#15110e" stroke="#d89a3a" stroke-width="3"/><rect x="9" y="13" width="14" height="3" rx="1.5" fill="#d89a3a"/>${dot}</svg>`;
  $('#favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ── Dialogs ─────────────────────────────────────────────────────────────────────────────
// Modal, with focus kept inside and returned to where it came from when closed.

export function openDialog({ title, sub, body, foot, size = '', role = 'dialog', onClose, initialFocus }) {
  const back = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    if (back?.isConnected) back.focus();
  };
  const dialog = h(
    `div.dialog${size ? '.' + size : ''}`,
    { role, 'aria-modal': 'true', 'aria-labelledby': titleId },
    h(
      'div.d-head',
      h('div.grow', h('h2.title', { id: titleId }, title), sub ? h('p.small.dim', sub) : null),
      h('button.btn.icon.sm.ghost', { 'aria-label': 'Close', onclick: close }, icon('x')),
    ),
    h('div.d-body', body),
    foot ? h('div.d-foot', foot) : null,
  );
  const backdrop = h(
    'div.backdrop',
    {
      onmousedown: (e) => {
        if (e.target === backdrop) close();
      },
    },
    dialog,
  );
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') {
      const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', dialog).filter((x) => !x.disabled && x.offsetParent !== null);
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
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  (initialFocus?.() ?? $('input, textarea, select, button.send, .d-body button', dialog))?.focus();
  return { close, dialog };
}

// ── Menus ───────────────────────────────────────────────────────────────────────────────

let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.();
  openMenuEl = null;
}
/**
 * A popover menu anchored to a button. items: [{ label, icon?, desc?, kbd?, danger?, run }] or 'hr' or { heading }.
 */
export function openMenu(anchor, items, { className = '', placement = 'below', label = 'Menu' } = {}) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu', 'aria-label': label, class: className });
  const buttons = [];
  for (const it of items) {
    if (it === 'hr') {
      menu.append(h('hr'));
      continue;
    }
    if (it.heading) {
      menu.append(h('div.label', it.heading));
      continue;
    }
    const b = h(
      'button.mi',
      {
        role: 'menuitem',
        type: 'button',
        class: it.danger ? 'danger' : '',
        onclick: () => {
          closeMenu();
          it.run();
        },
      },
      it.icon ? icon(it.icon) : null,
      h('span.grow', { style: { textAlign: 'left' } }, it.label, it.desc ? h('span.d', it.desc) : null),
      it.kbd ? h('span.k', it.kbd) : null,
    );
    buttons.push(b);
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = Math.min(menu.offsetWidth, innerWidth - 16);
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - mw - 8))}px`;
  if (placement === 'above') menu.style.bottom = `${innerHeight - r.top + 6}px`;
  else menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  let i = 0;
  const focus = (k) => {
    i = (k + buttons.length) % buttons.length;
    buttons.forEach((b, j) => {
      b.classList.toggle('active', j === i);
    });
    buttons[i]?.focus();
  };
  focus(0);
  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focus(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      anchor.focus();
    }
  };
  const onDown = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu();
  };
  menu.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  openMenuEl = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown);
    anchor.setAttribute('aria-expanded', 'false');
  };
  return menu;
}

// ── Hover cards ─────────────────────────────────────────────────────────────────────────
// A loading bar fills under the card’s header; once full, the card is sticky and its links can be
// clicked. When the pointer leaves, the same bar counts back down before the card closes. Keyboard
// focus works the same way; Enter pins at once and Esc closes.

const DWELL = 650;
let card = null;
export function initHoverCards(resolve) {
  const show = (trigger, pinNow = false) => {
    if (card?.trigger === trigger) {
      if (pinNow) pin();
      return;
    }
    hide(true);
    const content = resolve(trigger);
    if (!content) return;
    const bar = h('i', { style: { width: '0%' } });
    const el = h(
      'div.hovercard',
      { role: 'dialog', 'aria-label': content.label },
      h('div.hc-head', content.head),
      h('div.loadbar', { 'aria-hidden': 'true' }, bar),
      h('div.hc-body', content.body, h('span.small.dim', { class: 'hc-hint' }, 'Keep pointing to pin · Esc closes')),
    );
    document.body.append(el);
    place(el, trigger);
    trigger.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    card = { el, trigger, bar, pinned: false, timer: null, leaving: null };
    bar.animate([{ width: '0%' }, { width: '100%' }], { duration: DWELL, fill: 'forwards', easing: 'linear' });
    card.timer = setTimeout(pin, pinNow ? 0 : DWELL);
    el.addEventListener('pointerenter', cancelLeave);
    el.addEventListener('pointerleave', leave);
  };
  const pin = () => {
    if (!card) return;
    card.pinned = true;
    card.el.classList.add('pinned');
    card.bar.getAnimations().forEach((a) => {
      a.finish();
    });
    const hint = card.el.querySelector('.hc-hint');
    if (hint) hint.textContent = 'Pinned · move away to close · Esc closes';
  };
  const leave = () => {
    if (!card) return;
    if (!card.pinned) {
      hide();
      return;
    }
    clearTimeout(card.leaving);
    card.bar.getAnimations().forEach((a) => {
      a.cancel();
    });
    card.bar.animate([{ width: '100%' }, { width: '0%' }], { duration: DWELL, fill: 'forwards', easing: 'linear' });
    card.leaving = setTimeout(() => hide(), DWELL);
  };
  const cancelLeave = () => {
    if (!card?.leaving) return;
    clearTimeout(card.leaving);
    card.leaving = null;
    card.bar.getAnimations().forEach((a) => {
      a.cancel();
    });
    card.bar.style.width = '100%';
  };
  const hide = () => {
    if (!card) return;
    clearTimeout(card.timer);
    clearTimeout(card.leaving);
    card.trigger.classList.remove('open');
    card.trigger.setAttribute('aria-expanded', 'false');
    card.el.remove();
    card = null;
  };
  const triggerOf = (t) => t?.closest?.('.cite, .term');
  document.addEventListener('pointerover', (e) => {
    const t = triggerOf(e.target);
    if (t) {
      if (card?.trigger === t) cancelLeave();
      else show(t);
    }
  });
  document.addEventListener('pointerout', (e) => {
    const t = triggerOf(e.target);
    if (t && card?.trigger === t && !card.el.contains(e.relatedTarget)) leave();
  });
  let quiet = null; // the trigger Escape just returned focus to: that focus mustn’t reopen its card
  document.addEventListener('focusin', (e) => {
    const t = triggerOf(e.target);
    if (t && t === quiet) quiet = null;
    else if (t) show(t);
  });
  document.addEventListener('focusout', (e) => {
    const t = triggerOf(e.target);
    if (t && card?.trigger === t && !card.el.contains(e.relatedTarget)) leave();
  });
  document.addEventListener('keydown', (e) => {
    const t = triggerOf(document.activeElement);
    if (e.key === 'Enter' && t) {
      e.preventDefault();
      show(t, true);
      pin();
    }
    if (e.key === 'Escape' && card) {
      const tr = card.trigger;
      hide();
      if (document.activeElement !== tr) {
        quiet = tr;
        tr.focus();
      }
    }
  });
  document.addEventListener('click', (e) => {
    const t = triggerOf(e.target);
    if (t?.classList.contains('cite')) {
      e.preventDefault();
      show(t, true);
      pin();
    }
  });
}

function place(el, trigger) {
  const r = trigger.getBoundingClientRect();
  el.style.position = 'fixed';
  const w = Math.min(340, innerWidth - 24);
  el.style.width = `${w}px`;
  el.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
  const below = r.bottom + 8;
  el.style.top = `${below + el.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 8) : below}px`;
}

/** Markdown for hover-card bodies (definitions are agent text, so they go through the renderer). */
export const mdNode = (src, opts) => h('div.md', { html: trusted(renderMarkdown(src, opts)) });
