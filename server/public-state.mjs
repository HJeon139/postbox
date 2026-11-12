// What reaches the browser (designs/architecture/security-boundaries.md, “What reaches the browser”). The state and the event stream go
// through these: /api/state, and the live and backlog frames. Every other route that answers with a piece of state
// does so directly, and carries only public keys’ data, which review holds until A2 adds the first private data, with
// a check that holds it. The Store’s history, its snapshots and its other subscribers keep the raw state and events.

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

/**
 * One event as a stream frame, built from its public form. With `open`, the conversations a page has open (#1155), an
 * item’s change in any other goes out as a cursor: the page holds no items there, and its header frame says what it
 * shows. With no `open` (a tool reading the stream), every public event goes out.
 * @param {{ seq: number, type: string, data?: any }} event @param {typeof EVENTS} [events] @param {Set<string> | null} [open]
 */
export function publicFrame(event, events = EVENTS, open = null) {
  const shut = open && event.type.startsWith('item.') && !open.has(event.data?.threadId);
  const ev = shut ? { seq: event.seq, type: STREAM.cursor, data: {} } : publicEvent(event, events);
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

/**
 * A thread’s header facts as a stream frame (shared/thread-header.mjs, #1155), unnumbered: the event before it carries
 * the seq. A header is read from the thread’s items and its conversation’s, so it goes out only while items are a public
 * key; were they made private, no header would. Null says the thread was removed.
 * @param {string} threadId @param {any} header
 */
export function publicHeaderFrame(threadId, header) {
  if (!PUBLIC_STATE_KEYS.includes('items')) return '';
  return `event: ${STREAM.header}\ndata: ${JSON.stringify({ threadId, header })}\n\n`;
}

/** Every thread’s header, for /api/state; none while items aren’t public. @param {Record<string, any>} headers */
export function publicHeaders(headers) {
  return PUBLIC_STATE_KEYS.includes('items') ? headers : {};
}

/**
 * A conversation’s items as the page may see them (/api/threads/:id/items and its search, server/items-routes.mjs):
 * the store’s own list while items are a public key, else null. @param {Record<string, any>} state @param {string} threadId
 */
export function publicItems(state, threadId) {
  return PUBLIC_STATE_KEYS.includes('items') ? (state.items[threadId] ?? []) : null;
}
