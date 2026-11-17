// A queued message’s text in its row (#1456): two lines tall, so words that arrive later move no button, and, when the
// clamp cuts it, a disclosure the person opens by click, Enter or Space, so the rest is never only in a hover’s tooltip
// (app/AGENTS.md, “Accessibility and keyboard”).

import { h } from './dom.mjs';

/** Opens or closes a clamped text; one the clamp doesn’t cut is no control. @param {HTMLElement} text */
function toggle(text) {
  if (text.getAttribute('role') !== 'button') return;
  text.setAttribute('aria-expanded', String(text.getAttribute('aria-expanded') !== 'true'));
}

/** A row’s text, empty: the row fills it. */
export function queuedTextNode() {
  const text = h('p.agent-queue-text', {
    onclick: () => toggle(text),
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (text.getAttribute('role') !== 'button') return;
      e.preventDefault();
      toggle(text);
    },
  });
  return text;
}

/**
 * Makes each row’s text a disclosure when the clamp cuts it, and plain text when it doesn’t. Reads every row’s size
 * before it changes any, so a long queue lays out once. An open one stays open.
 * @param {HTMLElement} list
 */
export function markClamped(list) {
  const texts = /** @type {HTMLElement[]} */ ([...list.querySelectorAll(':scope > li > .agent-queue-text')]);
  const cut = texts.map((text) => text.getAttribute('aria-expanded') === 'true' || text.scrollHeight > text.clientHeight + 1);
  for (const [i, text] of texts.entries()) {
    if (cut[i] === (text.getAttribute('role') === 'button')) continue;
    if (cut[i]) {
      text.setAttribute('role', 'button');
      text.setAttribute('tabindex', '0');
      text.setAttribute('aria-expanded', 'false');
    } else {
      text.removeAttribute('role');
      text.removeAttribute('tabindex');
      text.removeAttribute('aria-expanded');
    }
  }
}
