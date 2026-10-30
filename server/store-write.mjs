// The store’s optimistic writes (server/store.mjs, emit()): what emits leave queued is written one batch at a time.
//
// A batch Redis fails for a reason a retry can change (TRANSIENT: the connection, or Redis short of memory or busy)
// puts the store in a failed state, which fails closed (#508’s design, “Storage”, decision 7; review finding 6 on
// #525): writable is false, the status says why, emits and commits are refused, and the batch stays queued, in order.
// It’s tried again after a backoff (RETRY_MS doubling to RETRY_MAX), and at once when the child starts again; the first
// write that succeeds ends the failed state, and what waited is written. ESEQ (another process wrote) isn’t retried:
// only a restart, which reads Redis again, ends it. Queued events were already broadcast, so if Postbox stops while
// failed they’re lost, and close() logs how many. flush() returns once the store can’t write. A batch whose reply was
// lost (ESTOREDOWN) isn’t a failure: it may be in Redis, so writes close until the store has read Redis back
// (server/store-recover.mjs).
//
// A batch Redis refuses for a reason no retry changes (a document RedisJSON won’t hold, a key of the wrong type, a
// script error) is dropped, since keeping it would refuse every write after it until a restart, which drops it anyway
// with the innocent events beside it (#553’s review, blocker 2). The store logs it, keeps it in its status as
// `dropped`, which /api/state and the stream’s status line carry, and goes on writing. Its events were broadcast, so
// browsers hold changes Redis doesn’t; a restart reads Redis back without them. The store checks every event’s JSON
// before it’s applied (server/store-check.mjs), so this is a last resort, not the way a deep event is refused.

import { closeWrites } from './store-recover.mjs';
import { writeBatch } from './store-redis.mjs';
import { changed } from './store-status.mjs';

const RETRY_MS = 250; // the first wait before a failed write is tried again
const RETRY_MAX = 30000; // the longest

/** Why a write failed when a retry can change it: the connection, or Redis short of memory, loading or busy. */
const TRANSIENT = new Set(['ESTOREDOWN', 'EPROTO', 'ESEQ', 'OOM', 'LOADING', 'BUSY', 'MISCONF', 'TRYAGAIN', 'READONLY', 'NOREPLICAS', 'MASTERDOWN']);

/** @typedef {import('./store.mjs').Store} Store */

/** @param {Store} store @param {boolean} retrying  a failed batch’s retry */
export function pump(store, retrying) {
  if (store.inflight || store.hold || store.reconciling || (store.failed && !retrying) || !store.lines.length || !store.client?.connected) return;
  const batch = store.take();
  store.inflight = writeBatch(store.client, { prev: store.confirmed, events: batch.events, writes: batch.writes })
    .then(
      (r) => {
        store.confirmed = r.seq;
        if (store.failed) recovered(store);
      },
      (e) => {
        if (!TRANSIENT.has(e.code)) return drop(store, batch, e);
        store.untake(batch);
        // The reply was lost, so the batch may be in Redis: read it back before writing again (server/store-recover.mjs).
        if (e.code === 'ESTOREDOWN') return closeWrites(store);
        store.failed = e;
        if (e.code !== 'ESEQ') retryLater(store);
        console.error(`Couldn’t write to the store: ${e.message}`);
        changed(store);
      },
    )
    .finally(() => {
      store.inflight = null;
      store.pump();
    });
}

/**
 * Drops a batch Redis refused for a reason no retry changes, and says so: in the log, and in the status, which the page
 * shows as a notice. The store stays writable; the next batch follows the seq Redis holds.
 * @param {import('./store.mjs').Store} store @param {ReturnType<Store['take']>} batch @param {Error & { code?: string }} e
 */
function drop(store, batch, e) {
  const seqs = batch.events.map((x) => x.seq);
  store.dropped = {
    at: Date.now(),
    events: seqs.length,
    from: seqs[0] ?? null,
    to: seqs.at(-1) ?? null,
    documents: batch.dirty.length,
    message: e.message,
  };
  console.error(
    `The store’s Redis refused a write for a reason a retry can’t change, so Postbox dropped it: ${seqs.length} event(s) (${seqs[0] ?? '-'}–${seqs.at(-1) ?? '-'}) and ${batch.dirty.length} document(s) weren’t saved. ${e.message} Postbox keeps saving the changes after it; a restart reads back what Redis holds, without them.`,
  );
  changed(store);
}

/** Tries a failed batch again after the backoff. @param {import('./store.mjs').Store} store */
function retryLater(store) {
  if (store.retry) return;
  store.backoff = Math.min(Math.max(store.backoff * 2, RETRY_MS), RETRY_MAX);
  store.retry = setTimeout(() => {
    store.retry = null;
    if (!store.failed) return;
    if (!store.lines.length) return recovered(store);
    store.pump(true);
    // A commit or a write in flight held the retry back: try again after the next wait.
    if (!store.inflight) retryLater(store);
  }, store.backoff);
}

/** Ends the failed state, and stops a retry. @param {import('./store.mjs').Store} store */
export function recovered(store) {
  if (store.retry) clearTimeout(store.retry);
  store.retry = null;
  store.backoff = 0;
  store.failed = null;
  changed(store);
}

/** The status while writes fail, or null. @param {import('./store.mjs').Store} store */
export function failedStatus(store) {
  if (!store.failed || store.redis?.sup.status.state !== 'running') return null;
  const next = store.failed.code === 'ESEQ' ? 'Start Postbox again to read it.' : 'Postbox keeps what waits and tries again.';
  return {
    state: 'down',
    cause: 'write-failed',
    message: `The store’s Redis refused a write, so Postbox isn’t saving changes: ${store.failed.message} ${next}`,
  };
}
