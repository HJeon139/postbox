// Hover cards for citations and glossary terms. ui.mjs re-exports initHoverCards, so callers import it from there.

import { h } from './dom.mjs';

// ── Hover cards ─────────────────────────────────────────────────────────────────────────
// A loading bar fills under the card’s header; once full, the card is sticky and its links can be
// clicked. When the pointer leaves, the same bar counts back down before the card closes. Keyboard
// focus works the same way; Enter or Space pins at once and moves into the card, and Esc closes.
// A term inside a card opens a card of its own over it (#103). Cards stack up to MAX_DEPTH deep, and a term whose card
// is already open below never opens another, so a cycle (U → U:13 → U) stops. Leaving a card closes it and the cards
// above it, not the one it was opened from; Esc closes the top card and returns focus to its term.

const DWELL = 650;
const MAX_DEPTH = 3;
/** The open cards: the first opened from the page, and each after it from a term in the one before. */
const stack = [];
// A reaction’s button (#320) opens a card of who made it, as a term does, but keeps its own keys and state: Enter and
// Space react, and it says it’s pressed, not expanded.
const triggerOf = (t) => t?.closest?.('.cite, .term, .react-btn');
const ownButton = (t) => t.classList.contains('react-btn');
const cardOf = (trigger) => stack.find((c) => c.trigger === trigger);
/** The index of the top card a node is in, or -1. */
const depthOf = (node) => stack.findLastIndex((c) => c.el.contains(node));
let quiet = null; // the trigger focus just returned to from its card: that focus mustn’t reopen it

export function initHoverCards(resolve) {
  document.addEventListener('pointerover', (e) => {
    const t = triggerOf(e.target);
    if (t) {
      const c = cardOf(t);
      if (c) stay(c);
      else show(t, resolve);
    }
  });
  document.addEventListener('pointerout', (e) => {
    const c = cardOf(triggerOf(e.target));
    if (c) left(c, e.relatedTarget);
  });
  document.addEventListener('focusin', (e) => {
    const t = triggerOf(e.target);
    if (t && t === quiet) quiet = null;
    else if (t) show(t, resolve);
  });
  document.addEventListener('focusout', (e) => {
    const c = cardOf(triggerOf(e.target));
    if (c) left(c, e.relatedTarget);
  });
  document.addEventListener('keydown', (e) => {
    const t = triggerOf(document.activeElement);
    // A term whose card can’t open (a cycle, or past the depth) leaves the key alone.
    const c = (e.key === 'Enter' || e.key === ' ') && t && !ownButton(t) ? show(t, resolve, true) : null;
    if (c) {
      e.preventDefault();
      pin(c);
      // Into the card, so the keyboard reaches its links and terms.
      c.el.focus({ preventScroll: true });
    }
    if (e.key === 'Escape' && stack.length) {
      // Escape was for the card, so it’s handled: a full-screen view under it stays (pane.mjs).
      e.preventDefault();
      const tr = stack.at(-1).trigger;
      hide(stack.at(-1));
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
      pin(show(t, resolve, true));
    }
  });
}

/** Opens a trigger’s card over the card it’s in, closing any above that one. Returns the card, or null for none. */
function show(trigger, resolve, pinNow = false) {
  const open = cardOf(trigger);
  if (open) {
    if (pinNow) pin(open);
    return open;
  }
  const under = depthOf(trigger);
  if (stack[under + 1]) hide(stack[under + 1]);
  const key = trigger.dataset.term ?? null;
  if (stack.length >= MAX_DEPTH || (key && stack.some((c) => c.key === key))) return null;
  const content = resolve(trigger);
  if (!content) return null;
  const bar = h('i', { style: { width: '0%' } });
  const el = h(
    'div.hovercard',
    { role: 'dialog', 'aria-label': content.label, tabindex: '-1' },
    h('div.hc-head', content.head),
    h('div.loadbar', { 'aria-hidden': 'true' }, bar),
    h('div.hc-body', content.body, h('span.small.dim', { class: 'hc-hint' }, 'Keep pointing to pin · Esc closes')),
  );
  document.body.append(el);
  place(el, trigger);
  trigger.classList.add('open');
  if (!ownButton(trigger)) trigger.setAttribute('aria-expanded', 'true');
  const card = { el, trigger, bar, key, pinned: false, timer: null, leaving: null };
  stack.push(card);
  bar.animate([{ width: '0%' }, { width: '100%' }], { duration: DWELL, fill: 'forwards', easing: 'linear' });
  card.timer = setTimeout(() => pin(card), pinNow ? 0 : DWELL);
  el.addEventListener('pointerenter', () => stay(card));
  el.addEventListener('pointerleave', (e) => left(card, e.relatedTarget));
  el.addEventListener('focusout', (e) => left(card, e.relatedTarget));
  return card;
}

function pin(card) {
  if (!card) return;
  stay(card);
  card.pinned = true;
  card.el.classList.add('pinned');
  card.bar.getAnimations().forEach((a) => {
    a.finish();
  });
  const hint = card.el.querySelector('.hc-hint');
  if (hint) hint.textContent = 'Pinned · move away to close · Esc closes';
}

/**
 * The pointer or focus left a card, or its trigger, for node `to`. Unless that’s a card opened above it, each card
 * above the one `to` is in closes: at once when it isn’t pinned, else after the bar counts down.
 */
function left(card, to) {
  const from = stack.indexOf(card);
  const at = depthOf(to);
  if (from < 0 || at > from) return;
  for (const c of stack.slice(at + 1).reverse()) leave(c);
}

function leave(card) {
  if (!card.pinned) {
    hide(card);
    return;
  }
  clearTimeout(card.leaving);
  card.bar.getAnimations().forEach((a) => {
    a.cancel();
  });
  card.bar.animate([{ width: '100%' }, { width: '0%' }], { duration: DWELL, fill: 'forwards', easing: 'linear' });
  card.leaving = setTimeout(() => hide(card), DWELL);
}

/** Keeps a card, and the cards under it, from closing. */
function stay(card) {
  for (const c of stack.slice(0, stack.indexOf(card) + 1)) {
    if (!c.leaving) continue;
    clearTimeout(c.leaving);
    c.leaving = null;
    c.bar.getAnimations().forEach((a) => {
      a.cancel();
    });
    c.bar.style.width = '100%';
  }
}

/** Closes a card and every card above it. Focus inside one goes back to the term that opened the lowest. */
function hide(card) {
  const at = stack.indexOf(card);
  if (at < 0) return;
  const closing = stack.splice(at);
  const held = closing.some((c) => c.el.contains(document.activeElement));
  for (const c of closing.reverse()) {
    clearTimeout(c.timer);
    clearTimeout(c.leaving);
    c.trigger.classList.remove('open');
    if (!ownButton(c.trigger)) c.trigger.setAttribute('aria-expanded', 'false');
    c.el.remove();
  }
  if (held && card.trigger.isConnected) {
    quiet = card.trigger;
    card.trigger.focus({ preventScroll: true });
  }
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
