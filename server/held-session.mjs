// Deliveries that wait for their session to be published (#796's class in sessions): a session made behind a held
// commit is only in store.pending, so its first turn starts once the commit is released, or, while writes are closed,
// once they reopen (server/store-outage.mjs). It takes the runtime first.

import { whenWritable } from './store-outage.mjs';

/** @typedef {import('./runtime.mjs').Runtime} Runtime */

/**
 * The deliveries waiting for a session just made behind a held commit, per runtime and session, in the order they
 * came (heldSession). In memory only: what they deliver is held with the session, and a restart loses both (#601).
 * @type {WeakMap<Runtime, Map<string, (() => void)[]>>}
 */
const sessionWaits = new WeakMap();

/**
 * Whether a delivery waits for its session to be published: one made behind a held commit is only in store.pending, so
 * a turn for it can't start, and the person's first @-mention of an agent threw 404 after their message posted (#796's
 * class in sessions). A flush settles after every emit held before it, so the deliveries run once the session is
 * published; while writes are closed they wait for them to reopen, as a held turn does. The session is published
 * before the flush settles, so a delivery that comes while others wait joins them, behind them: the person's
 * follow-up never starts the agent's first turn ahead of the message that made it.
 * @param {Runtime} rt @param {string} sessionId @param {() => void} start  the delivery again
 */
export function heldSession(rt, sessionId, start) {
  const waits = sessionWaits.get(rt) ?? new Map();
  const waiting = waits.get(sessionId);
  if (waiting) {
    waiting.push(start);
    return true;
  }
  if (rt.s.sessions[sessionId] || !rt.store.pending.session(sessionId)) return false;
  sessionWaits.set(rt, waits);
  waits.set(sessionId, [start]);
  const go = () => {
    const each = waits.get(sessionId) ?? [];
    waits.delete(sessionId);
    for (const again of each) {
      // Inside a promise's callback: a throw here (the session gone meanwhile) would be an unhandled
      // rejection, which ends Postbox.
      try {
        again();
      } catch (e) {
        console.error(`A message for a new agent wasn’t delivered: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  rt.store.flush().then(go, () => whenWritable(rt, go));
  return true;
}
