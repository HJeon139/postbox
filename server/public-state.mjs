// What reaches the browser (designs/architecture.md, “What reaches the browser”). The state and the event stream go
// through these: /api/state, and the live and backlog frames. Every other route that answers with a piece of state
// does so directly, and carries only public keys’ data, which review holds until A1b’s check. The Store’s history, its
// snapshots and its other subscribers keep the raw state and events.

import { EVENTS, PUBLIC_STATE_KEYS, STREAM } from '../shared/state.mjs';

/** The state with only its public keys. Shallow: the values are the store’s own. @param {Record<string, any>} state */
export function publicState(state) {
  return Object.fromEntries(PUBLIC_STATE_KEYS.filter((k) => Object.hasOwn(state, k)).map((k) => [k, state[k]]));
}

/**
 * The event as the page may see it: itself if its type is public, otherwise a cursor that keeps only its seq, so the
 * page stays in step without learning what happened. A type with no entry fails closed the same way.
 * @param {{ seq: number, type: string, data?: any }} event @param {typeof EVENTS} [events]
 */
export function publicEvent(event, events = EVENTS) {
  return Object.hasOwn(events, event.type) && events[event.type].public ? event : { seq: event.seq, type: STREAM.cursor, data: {} };
}

/** One event as a stream frame, built from its public form. @param {{ seq: number, type: string, data?: any }} event @param {typeof EVENTS} [events] */
export function publicFrame(event, events = EVENTS) {
  const ev = publicEvent(event, events);
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
