// The store when a write’s reply is lost or its Redis child comes back (#508’s design, “Storage”, decision 7;
// re-review finding 2 on #525).
//
// The rule: a write whose reply was lost may be in Redis or not, so the store reads Redis back before it takes another.
// From the moment a reply is lost or the child stops, writes are closed: writable is false, emits and commits are
// refused, and the status says the store is reconciling. Once the child runs, reconciliation waits for the write in
// flight and every queued commit to settle, then catch-up reads Redis’s seq and applies every event past what the
// store knows: a lost batch of its own emits is dropped from what waits, and a lost commit’s events are applied from
// the stream, once (a retry with its opId then finds it done). Emits held behind a lost commit stay held through it
// and are numbered after it. Only then do writes open again, and what waited is written. A catch-up that fails is tried
// again after a backoff while the child runs; a child that stops again starts it over.
//
// The store’s connection dropping is a lost reply too, even with nothing in flight (gpt’s outage review, finding 1): the
// child may still run, but nothing the store sends reaches it, so writes close, the status says the store is
// reconciling, and reconciliation reconnects, catches up and reopens. It starts after RETRY_MS rather than at once: a
// drop usually comes just before the child’s exit is heard, and a connection that keeps dropping isn’t hammered. Retry
// starts it now.

import { randomBytes } from 'node:crypto';
import { repair } from './store-reject.mjs';
import { changed } from './store-status.mjs';

/**
 * A history epoch: the token that names one readback of Redis into memory. A page’s events are numbered within an
 * epoch; one that reconnects naming another epoch holds a timeline this store never had, whatever its seq, and must
 * load the state again (server/live-streams.mjs; the integrator’s re-review of #553, blocker 3).
 */
export const newEpoch = () => randomBytes(9).toString('base64url');

/**
 * Replaces the store’s memory with what Redis holds: the state, the items’ positions and the index, with nothing
 * queued and no backlog, under a new history epoch, written to Redis beside `seq` so a reader there can tell which
 * readback is current. A restart’s load and a repair’s reload (server/store-reject.mjs) both end here.
 * @param {Store} store @param {any} state @param {import('./store-docs.mjs').Positions} positions
 */
export async function reload(store, state, positions) {
  store.state = state;
  store.positions = positions;
  store.confirmed = state.seq;
  store.index = new Map();
  for (const [t, list] of Object.entries(state.items)) for (const it of list) store.index.set(it.id, { t, it });
  store.lines = [];
  store.dirty.clear();
  store.events.length = 0;
  store.epoch = newEpoch();
  if (store.client?.connected) await store.client.call('SET', 'epoch', store.epoch);
}

const RETRY_MS = 250; // the first wait before a failed catch-up is tried again
const RETRY_MAX = 30000; // the longest

/** @typedef {import('./store.mjs').Store} Store */
/**
 * @typedef {{ run: Promise<void> | null, again: boolean, timer: ReturnType<typeof setTimeout> | null, backoff: number }} Reconciler
 *   the reconciliation running, whether it was asked again while it ran, and the next try of a failed catch-up and
 *   the ms before it
 */

/**
 * Takes a connection to the child. When it drops, writes close until the store has reconnected and read Redis back; a
 * connection the store already let go of (closed, or replaced) is ignored.
 * @param {Store} store @param {import('./redis-client.mjs').RedisClient} c
 */
export function attach(store, c) {
  store.client = c;
  c.ondrop = () => {
    if (store.client !== c || store.closed) return;
    store.reconciling = true;
    changed(store);
    later(store, RETRY_MS);
  };
}

/** Runs reconciliation after ms, unless a run is already waiting. @param {Store} store @param {number} ms */
function later(store, ms) {
  store.rc.timer ??= setTimeout(() => {
    store.rc.timer = null;
    reconcile(store);
  }, ms);
}

/** The child went down or came back: drop the connection, and close writes. @param {Store} store @param {any} s */
export function onStatus(store, s) {
  if (s.state !== 'running') {
    store.client?.close();
    store.client = null;
    if (s.state === 'down') console.error(`The store is read-only for now: ${s.message}`);
  }
  closeWrites(store);
}

/** Closes writes until the store has read Redis back, and reads it back now if the child runs. @param {Store} store */
export function closeWrites(store) {
  store.reconciling = true;
  changed(store);
  if (store.redis?.sup.status.state === 'running') reconcile(store);
}

/** Runs reconciliation, once at a time; asked again while it runs, it runs again after. @param {Store} store */
export function reconcile(store) {
  const rc = store.rc;
  if (rc.run) {
    rc.again = true;
    return rc.run;
  }
  rc.run = (async () => {
    do {
      rc.again = false;
      await once(store);
    } while (rc.again);
  })().finally(() => {
    rc.run = null;
  });
  return rc.run;
}

/** @param {Store} store */
async function once(store) {
  const sup = store.redis?.sup;
  if (!store.reconciling || store.closed || sup?.status.state !== 'running') return;
  try {
    if (!store.client?.connected) {
      store.client?.close();
      attach(store, await sup.client());
    }
    // A write or commit sent before the reply was lost settles first: its outcome is what catch-up reads.
    await store.inflight;
    await store.commits;
    store.recovered();
    await store.catchUp();
    // A refused batch still queued (its repair didn’t land, or none ran) keeps the store refused: Retry repairs it,
    // nothing writes it again on its own (server/store-reject.mjs).
    if (store.rejected) store.failed = store.rejected.failed;
  } catch (e) {
    if (e.code === 'ESEQ') return open(store, e);
    console.error(`Couldn’t read the store back: ${e.message}`);
    store.rc.backoff = Math.min(Math.max(store.rc.backoff * 2, RETRY_MS), RETRY_MAX);
    later(store, store.rc.backoff);
    return;
  }
  // The child stopped, or another loss came, while it read: what it read may be stale, so it reads again.
  if (store.rc.again || sup.status.state !== 'running' || !store.client?.connected) return;
  open(store, null);
}

/** Opens writes again, or leaves them failed, and publishes what was held. @param {Store} store @param {any} failed */
function open(store, failed) {
  if (failed) store.failed = failed;
  store.reconciling = false;
  store.rc.backoff = 0;
  stopReconciling(store);
  if (store.hold && !store.waiting) store.release();
  else store.pump();
  changed(store);
}

/** Stops a catch-up waiting to be tried again. @param {Store} store */
export function stopReconciling(store) {
  if (store.rc.timer) clearTimeout(store.rc.timer);
  store.rc.timer = null;
}

/** The status while the store reconnects to Redis or reads it back, or null. @param {Store} store */
export function reconcilingStatus(store) {
  if (!store.reconciling || store.redis?.sup.status.state !== 'running') return null;
  return {
    state: 'down',
    cause: 'reconciling',
    message: 'Postbox is reading back what the store’s Redis holds, after it restarted or its connection dropped, before it saves changes again.',
  };
}

/**
 * Retry, from the page’s status line: starts the child again when it’s down, reconnects and reads Redis back now
 * rather than after a wait, or tries a failed write again now. A write Redis refused for good (EREJECTED) is repaired:
 * its events Redis takes are saved and the state read back from Redis (server/store-reject.mjs). A write refused because
 * another process took its seq (ESEQ) waits for Postbox to start again, so Retry leaves it. Resolves to the status after.
 * @param {import('./store.mjs').Store} store
 */
export async function retry(store) {
  if (!store.redis || store.closed) return store.status;
  const sup = store.redis.sup;
  if (sup.status.state === 'down') await sup.restart();
  else if (store.reconciling) {
    stopReconciling(store);
    store.rc.backoff = 0;
    await reconcile(store);
  } else if (store.failed?.code === 'EREJECTED') await repair(store);
  else if (store.failed && store.failed.code !== 'ESEQ') store.pump(true);
  changed(store);
  return store.status;
}
