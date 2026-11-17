// What a page holds while turns run (designs/architecture/live-progress.md): the store’s events and its live frames, in
// the order the store sent them, applied through the reducer the page runs, a step frame as an item’s activityStep and
// a session frame as a session’s patch, as app/js/live-frames.mjs applies them. For a test that asks what a person
// sees mid-turn, now that a step’s updates and a session’s live fields reach the page live, not through the log.

import { onLive } from '../server/store-live.mjs';
import { EVENTS, emptyState } from '../shared/state.mjs';

/** What the page has heard of `store` from now on. Attach it before anything happens on the store. @param {any} store */
export function pageView(store) {
  /** @type {Array<[string, any]>} */
  const heard = [];
  // A copy as it’s heard: the store goes on changing an event’s objects in place (an added item grows by its text).
  store.subscribe((/** @type {any} */ ev) => heard.push([ev.type, structuredClone(ev.data)]));
  onLive(store, (/** @type {any} */ f) => {
    if (f.kind === 'step') heard.push(['item.patch', { threadId: f.threadId, id: f.itemId, activityStep: structuredClone(f.step) }]);
    if (f.kind === 'session') {
      const { kind, sessionId, ...patch } = f;
      heard.push(['session.patch', { id: sessionId, patch: structuredClone(patch) }]);
    }
  });
  return {
    /** The state as the page holds it now. */
    state() {
      const s = emptyState();
      for (const [type, data] of heard) if (Object.hasOwn(EVENTS, type)) EVENTS[type].apply(s, structuredClone(data));
      return s;
    },
  };
}
