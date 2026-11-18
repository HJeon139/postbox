// Where an app’s postbox.send goes (#1488): one click starts one turn. A send right after the person’s click or key
// press in the app (apps.mjs’s activated check) is an event, which starts its agent’s turn, with no limit and no card.
// Any other send is a note the agent reads with read_app at its next turn: no turn, no line in the person’s voice, no
// card (server/app-notes.mjs). That covers a send with no click (on load, on a timer, after a long await, from a frame
// that took the keyboard, or in a browser without MessageEvent.userActivation), and the rest of one click’s burst.

import { api } from './client.mjs';
import { inOrder } from './send-chain.mjs';

/**
 * A burst of sends from one click is one turn: one click handler’s sends arrive while its first event is still on its
 * way, or, when it awaits each, within moments of the answer. A person’s next click or key press comes later, and one
 * that didn’t would lose nothing: it reaches the agent as a note.
 */
const SAME_CLICK_MS = 50;
/** Apps whose turn-starting event is on its way to the server. */
const inFlight = new Set();
/** appId → when its last event reached the agent; a refused one doesn’t count. */
const lastEvent = new Map();

const sameClick = (/** @type {string} */ appId, now = Date.now()) => inFlight.has(appId) || now - (lastEvent.get(appId) ?? -Infinity) < SAME_CLICK_MS;

/**
 * Sends an app’s event or note, after the app’s sends before it (#934), so the server stores them in the order the app
 * sent them. Resolves to the server’s answer: `{ ok, noted: true }` for a note.
 * @param {string} appId @param {boolean} clicked  whether the person’s click or key press came with it
 * @param {{ action: unknown, values: unknown }} m
 */
export function sendFromApp(appId, clicked, m) {
  const route = clicked && !sameClick(appId) ? 'event' : 'note';
  if (route === 'event') inFlight.add(appId);
  return inOrder(appId, async () => {
    try {
      const r = await api(`/api/apps/${encodeURIComponent(appId)}/${route}`, { action: m.action, values: m.values });
      if (route === 'event') lastEvent.set(appId, Date.now());
      return r;
    } finally {
      if (route === 'event') inFlight.delete(appId);
    }
  });
}
