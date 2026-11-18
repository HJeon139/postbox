// Work’s way back to the conversation (#195): an item the agents showed, opened where it is, with focus on it. Moved
// from app/js/work-sections.mjs.

import { reach } from './open-threads.mjs';
import { navigate, paneHref, route, setPaneFull } from './ui.mjs';
import { jumpTo } from './view-jump.mjs';
import { mountFor } from './window-live.mjs';

/** Leaves full-screen Work for the conversation, at an item there, with focus on it. */
export function showItem(conv, p) {
  if (route().full) setPaneFull(null);
  if (p.threadId !== conv) navigate(paneHref(conv, { side: p.threadId, work: route().work }), { replace: true });
  // The range around the item first, if the page hasn’t loaded it (#1155).
  void reach(p.threadId, p.itemId).then(() => {
    const el = mountFor(p.itemId) ?? /** @type {HTMLElement|null} */ (document.querySelector(`.transcript [data-key="${CSS.escape(p.itemId)}"]`));
    el?.setAttribute('tabindex', '-1');
    if (el) jumpTo(el);
    el?.focus({ preventScroll: true });
  });
}
