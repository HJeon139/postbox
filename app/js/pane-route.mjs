// Where a conversation’s address goes when it isn’t the one it should have: the right pane’s routing that
// main.mjs runs before it renders.

import { client } from './client.mjs';
import { besideFits } from './pane-width.mjs';
import { paneHref, rememberWork, workRemembered } from './ui.mjs';

/**
 * The address a conversation’s route should have, when it isn’t the one it has: the Work page #138 had opens the
 * Work pane, and a conversation left with Work open opens it again (rememberWork in ui.mjs).
 */
export function canonical(r) {
  if (r.view !== 'thread' || !client.state.threads[r.threadId]) return null;
  if (r.oldWork) return paneHref(r.threadId, { work: true, turn: r.turn });
  if (r.work) rememberWork(r.threadId, true);
  // In a window with no room for the pane beside the conversation, coming back opens the conversation, not Work
  // over it (#197).
  else if (workRemembered(r.threadId) && besideFits()) return paneHref(r.threadId, { side: r.sideId, work: true });
  return null;
}
