// What reaches the browser (designs/architecture/security-boundaries.md, “What reaches the browser”). The state and the event stream go
// through these: /api/state, and the live and backlog frames. Every other route that answers with a piece of state
// does so directly, and carries only public keys’ data, which review holds until A2 adds the first private data, with
// a check that holds it. The Store’s history, its snapshots and its other subscribers keep the raw state and events.

import { LIVE, SESSION_FIELDS, STEP_FIELDS } from '../shared/live-kinds.mjs';
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

/** Only `keys` of an object, or null for what isn’t one. @param {any} o @param {readonly string[]} keys */
function pick(o, keys) {
  if (!o || typeof o !== 'object') return null;
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
}

/**
 * A live frame’s data as the page may see it (designs/architecture/live-progress.md, “What reaches the browser”), or
 * null. Its kind must be in LIVE and every event type it mirrors public in `events`, so it fails closed; an item’s
 * frame goes only to a stream with its conversation open (#1155’s `open`), and a session’s to every stream. Only the
 * kind’s fields are kept, a step’s and a snapshot’s parts by their own lists.
 * @param {any} frame @param {Set<string> | null} [open] @param {typeof EVENTS} [events]
 */
export function publicLiveData(frame, open = null, events = EVENTS) {
  const def = Object.hasOwn(LIVE, frame?.kind) ? LIVE[frame.kind] : null;
  if (!def?.events.every((t) => Object.hasOwn(events, t) && events[t].public)) return null;
  // A tool’s stream names no conversations (open is null) and gets them all.
  if (def.item && open instanceof Set && !open.has(frame.threadId)) return null;
  /** @type {Record<string, any>} */
  const data = { kind: frame.kind, ...pick(frame, def.fields) };
  if (frame.kind === 'step') data.step = pick(frame.step, STEP_FIELDS);
  if (frame.kind === 'snapshot') {
    data.text = pick(frame.text, ['at', 'text']);
    data.steps = (Array.isArray(frame.steps) ? frame.steps : []).map((st) => pick(st, STEP_FIELDS));
    data.session = pick(frame.session, SESSION_FIELDS);
  }
  return data;
}

/**
 * A live frame as the stream sends it, unnumbered: the event before it carries the seq. Empty when the page may not
 * have it. @param {any} frame @param {Set<string> | null} [open] @param {typeof EVENTS} [events]
 */
export function publicLiveFrame(frame, open = null, events = EVENTS) {
  const data = publicLiveData(frame, open, events);
  return data ? `event: ${STREAM.live}\ndata: ${JSON.stringify(data)}\n\n` : '';
}

/**
 * The running turns’ snapshots a page may have, by the same rules: for /api/state and a page whose frames for a turn
 * overflowed. @param {any[]} snapshots @param {Set<string> | null} [open] @param {typeof EVENTS} [events]
 */
export function publicLive(snapshots, open = null, events = EVENTS) {
  return snapshots.map((s) => publicLiveData({ ...s, kind: 'snapshot' }, open, events)).filter(Boolean);
}
