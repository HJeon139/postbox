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
    const t = id ? client.state.threads[id] : null;
    return t?.parentId === threadId ? id : null;
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
  // An address to a message opens its thread beside the conversation, never one remembered, and the Work left open
  // there, as messagePane says (#168).
  if (r.item) {
    if (r.work || !messagePane(current ?? {}, r.threadId, r.sideId ?? null).work) return null;
    return paneHref(r.threadId, { ...r, side: r.sideId, work: true, item: r.item });
  }
  // In a window with no room for the pane beside the conversation, coming back opens the conversation, not a view
  // over it (#197).
  if (!besideFits()) return null;
  const side = r.sideId ?? (here ? null : sideRemembered(r.threadId));
  const work = r.work || workRemembered(r.threadId);
  if (side === r.sideId && work === r.work) return null;
  return paneHref(r.threadId, { side, work, turn: r.turn, full: r.full, at: r.at });
}

/**
 * What a message’s address opens beside it (#168), from the route on screen: the one place that decides, for an address
 * made here (goToAddress, needs-nav.mjs) and one that comes in (canonical). Work is the conversation’s, so it stays open,
 * or opens as it was left in another conversation (#122), where the window has room for it beside the conversation: in
 * one too narrow, it would cover the message (#197). The side is the message’s thread. In the conversation on screen,
 * Work keeps its turn and an item open beside the thread, and a full view stays only if it’s the message’s own thread:
 * full-screen Work, or another thread, would cover the message.
 * @param {any} r  the route on screen @param {string} conv  the message’s conversation @param {string | null} side  its thread, if not the conversation
 */
export function messagePane(r, conv, side) {
  const here = r.view === 'thread' && r.threadId === conv;
  const work = besideFits() && (here ? !!r.work : workRemembered(conv));
  return {
    side,
    work,
    turn: here && work ? r.turn : null,
    full: here && r.full === 'thread' && r.sideId === side ? r.full : null,
    at: here && work && r.full !== 'work' ? r.at : null,
  };
}
