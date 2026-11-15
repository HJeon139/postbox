// What the page holds of each agent’s inbox (designs/rooms-at-scale.md, “What an entry is”): the entries it can act on,
// waiting, taken by a turn, failed or stopped. A delivered entry stays in the server’s state and log; the page leaves it
// out of /api/state (server/page-state.mjs) and drops it as the stream says it was delivered, so a page left open
// doesn’t grow with a room’s history (#1155’s bound, for items).

import { apply } from './state.mjs';

/** Whether the page holds an entry. @param {{ state: string }} e */
export const onPage = (e) => e.state !== 'delivered';

/** Each inbox with only the entries the page holds, and no empty one. @param {Record<string, any[]>} inbox */
export function pageInbox(inbox) {
  const kept = Object.create(null);
  for (const [sessionId, entries] of Object.entries(inbox ?? {})) {
    const open = entries.filter(onPage);
    if (open.length) kept[sessionId] = open;
  }
  return kept;
}

/**
 * After the page applies a stream event with the shared reducer: an entry patched to delivered leaves its inbox, and an
 * inbox left empty leaves the state. @param {any} state @param {string} type @param {any} data
 */
export function dropDelivered(state, type, data) {
  if (type !== 'entry.patch' || data?.patch?.state !== 'delivered') return;
  const list = state.inbox?.[data.sessionId];
  if (!list) return;
  const at = list.findIndex((/** @type {any} */ e) => e.id === data.id);
  if (at >= 0) list.splice(at, 1);
  if (!list.length) delete state.inbox[data.sessionId];
}

/** Applies a stream event to the page’s state: the shared reducer, then the page’s own drop of a delivered entry. */
export function applyOnPage(/** @type {any} */ state, /** @type {string} */ type, /** @type {any} */ data) {
  apply(state, type, data);
  dropDelivered(state, type, data);
}
