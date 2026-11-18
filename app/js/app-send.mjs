// Where an app’s postbox.send goes (#1488): one click starts one turn. The first send after the person’s click or key
// press in the app (apps.mjs’s activated check) is an event, which starts its agent’s turn, with no limit and no card.
// Any other send is a note the agent reads with read_app at its next turn: no turn, no line in the person’s voice, no
// card (server/app-notes.mjs). That covers a send with no click (on load, on a timer, from a frame that took the
// keyboard, or in a browser without MessageEvent.userActivation), and a click’s later sends.

import { api } from './client.mjs';
import { inOrder } from './send-chain.mjs';

// A click’s activation lasts about 5 s in Chromium, and a send doesn’t use it up: a click handler that awaits each
// send, or sleeps between them, finds it still active for every one. So one event spends the frame’s activation for
// those 5 s, as one link does in a pane (app-links.mjs, #1481), and the frame’s later sends in them are notes. Only the
// browser’s snapshot of the activation is trusted: anything the app puts in its message, it could forge. The cost: a
// person’s second click in the same app within the 5 s is a note too, not a turn.
const ACTIVATION_MS = 5000;
/** @type {WeakMap<HTMLIFrameElement, number>} when each app frame’s last turn-starting event spent its activation */
const spent = new WeakMap();

/** Whether this send is the first since the frame’s activation was last spent. */
const firstOfClick = (frame, now = Date.now()) => now - (spent.get(frame) ?? Number.NEGATIVE_INFINITY) >= ACTIVATION_MS;

/**
 * Sends an app’s event, or its note: one at a time per app (#934), so the server stores them in the order the app sent
 * them. Resolves to the server’s answer: `{ ok, noted: true }` for a note.
 * @param {string} appId @param {HTMLIFrameElement} frame @param {boolean} clicked  whether the person’s click or key
 * press in this app came with it @param {{ action: unknown, values: unknown }} m
 */
export function sendFromApp(appId, frame, clicked, m) {
  if (!clicked || !firstOfClick(frame)) return noteLater(appId, m);
  const before = spent.get(frame);
  const at = Date.now();
  spent.set(frame, at);
  return inOrder(appId, () => api(`/api/apps/${encodeURIComponent(appId)}/event`, { action: m.action, values: m.values })).catch((err) => {
    // A refused event started no turn, so it doesn’t spend the click.
    if (spent.get(frame) === at) {
      if (before !== undefined) spent.set(frame, before);
      else spent.delete(frame);
    }
    throw err;
  });
}

// Notes, as publishes (app-publish.mjs): an app may send one on every tick or keystroke, and each is kept in the log,
// so each app’s notes wait NOTE_MS and the latest goes, with how many it stands for. Every send of a gathered note
// answers with the answer to the one that went.
const NOTE_MS = 400;
/** Each app’s note waiting to go: the latest, how many it replaced, and the callers waiting on it. @type {Map<string, any>} */
const waiting = new Map();

/** @param {string} appId @param {{ action: unknown, values: unknown }} m @returns {Promise<any>} */
function noteLater(appId, m) {
  return new Promise((resolve, reject) => {
    let next = waiting.get(appId);
    if (next) next.replaced++;
    else {
      next = { replaced: 0, callers: [] };
      waiting.set(appId, next);
      setTimeout(() => sendNote(appId), NOTE_MS);
    }
    next.m = m;
    next.callers.push({ resolve, reject });
  });
}

/** Sends an app’s latest note after the one before it, under a key no app id can be. @param {string} appId */
function sendNote(appId) {
  const { m, replaced, callers } = waiting.get(appId);
  waiting.delete(appId);
  inOrder(`note ${appId}`, () => api(`/api/apps/${encodeURIComponent(appId)}/note`, { action: m.action, values: m.values, replaced })).then(
    (r) => {
      for (const c of callers) c.resolve(r);
    },
    (err) => {
      for (const c of callers) c.reject(err);
    },
  );
}
