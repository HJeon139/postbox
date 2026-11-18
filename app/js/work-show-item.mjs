// Work’s way back to the conversation (#195): an item the agents showed, opened where it is, with focus on it. Moved
// from app/js/work-sections.mjs.

import { reach } from './open-threads.mjs';
import { besideFits } from './pane-width.mjs';
import { navigate, paneHref, rememberWork, route, setPaneFull } from './ui.mjs';
import { jumpTo } from './view-jump.mjs';
import { mountFor } from './window-live.mjs';

/** Leaves Work for the conversation, at an item there, with focus on it. */
export function showItem(conv, p) {
  const r = route();
  const side = p.threadId !== conv ? p.threadId : null;
  // Where the pane covers the conversation, in a narrow window, it closes, as its Back to the conversation does: the
  // item would take focus behind it otherwise.
  if (!besideFits()) {
    rememberWork(conv, false);
    navigate(paneHref(conv, { side }), { replace: true });
  } else {
    if (r.full) setPaneFull(null);
    if (side) navigate(paneHref(conv, { side, work: r.work }), { replace: true });
  }
  // The range around the item first, if the page hasn’t loaded it (#1155).
  void reach(p.threadId, p.itemId).then(() => {
    const el = mountFor(p.itemId) ?? /** @type {HTMLElement|null} */ (document.querySelector(`.transcript [data-key="${CSS.escape(p.itemId)}"]`));
    el?.setAttribute('tabindex', '-1');
    if (el) jumpTo(el);
    el?.focus({ preventScroll: true });
  });
}
