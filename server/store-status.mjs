// What the store tells the rest of Postbox when it can’t be written (#508’s requirements, ST-3; design 6.6, decision 7):
// its watchers hear each time writes close or reopen, or the status the page shows changes, and Retry, from the page’s
// status line, asks it to try now (server/store-recover.mjs, retry). A connection that drops, idle or not, closes writes
// until the store has reconnected and read Redis back (server/store-recover.mjs, attach).
//
// The status the page gets says running exactly when the store can be written; otherwise down, with a cause: the
// child’s (server/redis-supervisor.mjs), reading back (store-recover.mjs), a failed write (store-write.mjs), or
// starting/stopped here.
//
// Watchers: the runtime stops running turns and holds new ones while writes are closed (server/store-outage.mjs), and
// the server sends the page its status line (server/index.mjs).

import { reconcilingStatus } from './store-recover.mjs';
import { failedStatus } from './store-write.mjs';

/**
 * The store’s status for the page: running exactly when it can be written; otherwise down, with its cause and what to
 * do. Down too while the child starts, while writes fail, and while the store reads Redis back (ST-3: the page hides
 * its line only when the store can be written).
 * @param {import('./store.mjs').Store} store
 */
export function statusOf(store) {
  // Changes Redis refused for good, dropped by Retry: the status says so while the store runs on (server/store-reject.mjs).
  if (!store.redis || store.writable) return store.dropped ? { state: 'running', dropped: store.dropped } : { state: 'running' };
  const sup = store.redis.sup.status;
  if (sup.state === 'down') return sup;
  return reconcilingStatus(store) ?? failedStatus(store) ?? notRunningStatus(sup.state);
}

/** Tells watchers once per change of writability or status. @param {import('./store.mjs').Store} store */
export function changed(store) {
  if (store.closed) return;
  const writable = store.writable;
  const status = store.status;
  const key = `${writable}${JSON.stringify(status)}`;
  if (key === store.seen) return;
  store.seen = key;
  for (const fn of store.watchers) fn(writable, status);
}

/**
 * The status while the child isn’t down but the store can’t be written for another reason than reading back or a
 * failed write: Postbox is starting it (after Retry or a restart) or connecting to it, or has stopped it.
 * @param {string} state  the supervisor’s state: idle, starting, running (not connected yet) or stopped
 * @returns {{ state: 'down', cause: 'starting' | 'stopped', message: string }}
 */
function notRunningStatus(state) {
  if (state === 'stopped')
    return { state: 'down', cause: 'stopped', message: 'Postbox stopped the store’s Redis as it shuts down. Start Postbox again to save changes.' };
  return {
    state: 'down',
    cause: 'starting',
    message: 'Postbox is starting the store’s Redis and connecting to it; it saves changes again once it has read Redis back.',
  };
}
