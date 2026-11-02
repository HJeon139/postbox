// Private record storage stays inside the Store. HTTP state and SSE frames use these projections; internal
// subscribers, the backlog ring and snapshots retain the original data (designs/508/a1-record-shape.md).
import { PRIVATE_EVENT_TYPES, PUBLIC_EVENT_TYPES, PUBLIC_STATE_KEYS } from '../shared/record-private.mjs';

/** @param {any} state */
export function publicState(state) {
  return Object.fromEntries(PUBLIC_STATE_KEYS.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
}

/** A cursor preserves the stream position without exposing any record identity or content. @param {any} event */
export function publicEvent(event) {
  return PRIVATE_EVENT_TYPES.includes(event.type) || !PUBLIC_EVENT_TYPES.includes(event.type) ? { seq: event.seq, type: 'cursor', data: {} } : event;
}

/** Frame-time projection is shared by live delivery and reconnect backlog. @param {any} event */
export function publicFrame(event) {
  const ev = publicEvent(event);
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
