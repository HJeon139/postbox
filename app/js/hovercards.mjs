// Hover cards for citations and glossary terms. ui.mjs re-exports initHoverCards, so callers import it from there.

import { h } from './dom.mjs';

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
      // Escape was for the card, so it’s handled: a full-screen view under it stays (pane.mjs).
      e.preventDefault();
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
