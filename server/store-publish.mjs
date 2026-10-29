// What the store’s subscribers hear (server/store.mjs, emit() and commit(); re-review finding 1 on #525). The reducer
// keeps an event’s objects in the state, where later events change them in place, so an event is published from its
// line: the JSON taken when it was made, before anything could change it. The same line is kept for a reconnecting
// browser’s replay, and is what the stream holds; subscribers share one deep-frozen copy parsed from it, so none can
// change what the others hear.

const KEEP_EVENTS = 20000; // events kept in memory for reconnecting browsers

/** Freezes a parsed event all the way down. @param {any} v */
const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) freeze(v[k]);
    Object.freeze(v);
  }
  return v;
};

/** Keeps an event for replay and tells subscribers. @param {import('./store.mjs').Store} store @param {number} seq @param {string} line */
export function broadcast(store, seq, line) {
  store.events.push({ seq, line });
  if (store.events.length > KEEP_EVENTS) store.events.splice(0, store.events.length - KEEP_EVENTS);
  if (!store.listeners.size) return;
  const ev = freeze(JSON.parse(line));
  for (const fn of store.listeners) fn(ev);
}
