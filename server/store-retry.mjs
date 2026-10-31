// Failing closed and Retry (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, revision 4). When a
// write or fsync of the log fails, fail() closes the store to commits with the cause, and tells the status listeners
// (server/live-streams.mjs sends the page its status line). Retry is reload(): one at a time, in this order, so nothing
// recovered is visible and nothing reconciled runs before the disk has been proven (I3):
//   a. quiesce the old writer: wait for a write still in flight, within a bound, since the fence below can stop its
//      completion from publishing in memory but not its bytes from landing in the log, where a stale line for a seq
//      the new writer has since acknowledged would displace the acknowledged one at the next load (I3c). Past the
//      bound Retry refuses: a restart ends the write one way or the other before the next load. Then bump the
//      generation (a late callback does nothing, I6) and close the descriptor;
//   b. recover() a private candidate from the folder: the snapshot and the segments, a torn tail trimmed first;
//   c. the barrier: fsync the retained segment on a FRESH descriptor, and the folder; a reload reads through the page
//      cache, and a second fsync on the failed descriptor proves nothing. If it fails, the candidate is dropped, the
//      old view stays readable, writes stay closed (I4);
//   d. install the candidate into the store’s state object (its identity kept, its collections replaced, I3a), a new
//      epoch, reset backlog and counters, tell the reload listeners (the streams send `resync`), reopen writes.
// A failed snapshot is the other outcome of the one failure policy (I5): it closes nothing, sets a warning, and a
// stored next-attempt time keeps it from being retried on every event.

import { syncDir } from './store-commit.mjs';
import { install, recover } from './store-recover.mjs';

const SNAPSHOT_BACKOFF_MS = 30_000; // after a failed snapshot, the first wait before another attempt
const SNAPSHOT_BACKOFF_MAX_MS = 10 * 60_000; // the wait doubles up to this

/**
 * Closes the store to commits on a write that failed (Q9): every queued commit, flush and snapshot is rejected with the
 * cause, held emits are released onto memory (applied and broadcast, not written), the loop ends, and the status
 * listeners hear. Nothing is written again until reload() reopens.
 * @param {import('./store.mjs').Store} store @param {Error & { code?: string }} e
 */
export function fail(store, e) {
  const cause = Object.assign(
    new Error(`Postbox can’t write its event log (${e.code ?? 'error'}): ${e.message}. Reads go on; changes aren’t saved until Retry or a restart.`),
    { code: e.code, cause: e },
  );
  console.error(cause.message);
  store.writable = false;
  store.cause = cause;
  const queue = store.queue;
  store.queue = [];
  for (const job of queue) {
    if (job.held)
      store.release(job); // applied and broadcast on the memory the page reads, not written, like every emit from now on
    else if (job.commit) store.waitingCommits--;
    (job.commit ?? job.flush ?? job.snapshot)?.reject(cause);
  }
  store.tellStatus();
}

/**
 * Retry, one at a time: a second call while one runs joins it. The status listeners hear the result only once the
 * whole order has run, reconciliation included, so nothing that waited starts early.
 * @param {import('./store.mjs').Store} store
 */
export function reload(store) {
  if (store.retrying) return store.retrying;
  // Nothing to retry while writes are open: a reload then would install the disk’s view over memory that is ahead of
  // it, and lose the events in flight (critic’s finding on 1b). A stale tab’s Retry, or a second click, is a no-op.
  if (store.retiring) return Promise.reject(store.cause); // closing or closed: another store may hold the folder soon
  if (store.writable || !store.dir) return Promise.resolve();
  store.retrying = retry(store).finally(() => {
    store.retrying = null;
    store.tellStatus();
  });
  store.tellStatus();
  return store.retrying;
}

/** The header’s order. @param {import('./store.mjs').Store} store */
async function retry(store) {
  if (store.running && !(await settledWithin(store.running, store.retryBoundMs))) {
    throw closedBy(store, Object.assign(new Error('a write is still in flight and the disk isn’t answering; restart Postbox'), { code: store.cause?.code }));
  }
  if (store.retiring) throw gone(store); // close() may begin between any two awaits here: each step checks before it acts
  store.generation++; // a.
  const old = store.fh;
  store.fh = null;
  await old?.close().catch(() => {});
  if (store.retiring) throw gone(store);
  let c;
  try {
    c = await recover(store); // b.
  } catch (e) {
    throw closedBy(store, e);
  }
  if (store.retiring) throw gone(store);
  const fh = await store.io.open(store.at(c.segment), 'a').catch((e) => {
    throw closedBy(store, e);
  });
  try {
    await fh.sync(); // c.
    await syncDir(store);
  } catch (e) {
    await fh.close().catch(() => {});
    throw closedBy(store, e);
  }
  if (store.retiring) {
    await fh.close().catch(() => {}); // close() began meanwhile: nothing installs or reopens
    throw gone(store);
  }
  install(store, c); // d.
  store.fh = fh;
  // Reconciliation (A2’s records going back to waiting; the I8 stand-in in the specs) runs now, through
  // store.reconcile(), and is awaited: its lines are durable before writes open and the status listeners run what
  // waited (gpt’s sixth finding on 1b). Meanwhile `writable` stays false, so the router, the tools and turn starts
  // are still refused: only the listeners’ internal path writes. A listener that fails leaves the store closed, naming
  // it; the next Retry reloads and reconciles afresh.
  store.reconciling = true;
  try {
    await Promise.all([...store.reloaders].map((fn) => fn()));
  } catch (e) {
    throw closedBy(store, Object.assign(new Error(`reconciliation after the reload failed: ${e.message}`), { code: e.code }));
  } finally {
    store.reconciling = false;
  }
  if (store.retiring) throw gone(store);
  store.writable = true;
  store.cause = null;
  store.warned = false;
  store.pump();
}

/** Whether a promise settles within `ms`; the timer is cleared either way, so it never holds the process open. */
export function settledWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Retry found the store closed between two of its steps: it ends here, having changed nothing public. */
const gone = (store) => closedBy(store, Object.assign(new Error('the store was closed while Retry ran'), { code: 'ECLOSED' }));

/** Records why Retry failed as the store’s cause (the status line shows the latest reason) and gives the error to throw. */
function closedBy(store, e) {
  const cause = Object.assign(new Error(`Retry couldn’t reopen the event log (${e.code ?? 'error'}): ${e.message}`), { code: e.code, cause: e });
  console.error(cause.message);
  store.cause = cause;
  return cause;
}

/** A failed snapshot: a warning, and a next-attempt time that doubles up to a cap. @param {import('./store.mjs').Store} store */
export function snapshotFailed(store, e) {
  store.snapshotBackoff = Math.min(store.snapshotBackoff ? store.snapshotBackoff * 2 : SNAPSHOT_BACKOFF_MS, SNAPSHOT_BACKOFF_MAX_MS);
  store.nextSnapshotAt = Date.now() + store.snapshotBackoff;
  store.warning = `A snapshot couldn’t be written (${e.code ?? 'error'}): ${e.message}. Changes are still saved to the log; Postbox tries again in ${Math.round(store.snapshotBackoff / 1000)} s.`;
  console.error(store.warning);
  store.tellStatus();
}

/** A snapshot that succeeded clears the warning and the backoff. @param {import('./store.mjs').Store} store */
export function snapshotSucceeded(store) {
  if (!store.warning) return;
  store.snapshotBackoff = 0;
  store.nextSnapshotAt = 0;
  store.warning = null;
  store.tellStatus();
}
