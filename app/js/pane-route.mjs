// Where a conversation’s address goes when it isn’t the one it should have: the right pane’s routing that
// main.mjs runs before it renders.

import { client } from './client.mjs';
import { besideFits } from './pane-width.mjs';
import { paneHref, rememberWork, workRemembered } from './ui.mjs';

// A conversation keeps the thread open in it, as it keeps Work (#122), in this browser: coming back from elsewhere
// opens it beside the conversation again, and closing it in the conversation forgets it.
const sideKey = (threadId) => `pb-side-${threadId}`;
function rememberSide(threadId, side) {
  try {
    if (side) localStorage.setItem(sideKey(threadId), side);
    else localStorage.removeItem(sideKey(threadId));
  } catch {}
}
/** The thread left open in a conversation, while it’s still there. */
function sideRemembered(threadId) {
  try {
    const id = localStorage.getItem(sideKey(threadId));
    return id && client.state.threads[id]?.parentId === threadId ? id : null;
  } catch {
    return null;
  }
}

/**
 * The address a conversation’s route should have, when it isn’t the one it has: the Work page #138 had opens the
 * Work pane, and a conversation left with Work or a thread open opens it again (rememberWork in ui.mjs).
 * @param {any} r  the route
 * @param {any} [current]  the route shown until now, which says whether this one stays in the conversation
 */
export function canonical(r, current = null) {
  if (r.view !== 'thread' || !client.state.threads[r.threadId]) return null;
  if (r.oldWork) return paneHref(r.threadId, { work: true, turn: r.turn });
  const here = current?.view === 'thread' && current.threadId === r.threadId;
  if (r.sideId) rememberSide(r.threadId, r.sideId);
  else if (here) rememberSide(r.threadId, null);
  if (r.work) rememberWork(r.threadId, true);
  // In a window with no room for the pane beside the conversation, coming back opens the conversation, not a view
  // over it (#197).
  if (!besideFits()) return null;
  const side = r.sideId ?? (here ? null : sideRemembered(r.threadId));
  const work = r.work || workRemembered(r.threadId);
  if (side === r.sideId && work === r.work) return null;
  return paneHref(r.threadId, { side, work, turn: r.turn, full: r.full, at: r.at });
}
