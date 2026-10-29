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

const RETRY_MS = 250; // the first wait before a failed catch-up is tried again
const RETRY_MAX = 30000; // the longest

/** @typedef {import('./store.mjs').Store} Store */
/**
 * @typedef {{ run: Promise<void> | null, again: boolean, timer: ReturnType<typeof setTimeout> | null, backoff: number }} Reconciler
 *   the reconciliation running, whether it was asked again while it ran, and the next try of a failed catch-up and
 *   the ms before it
 */

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
      store.client = await sup.client();
    }
    // A write or commit sent before the reply was lost settles first: its outcome is what catch-up reads.
    await store.inflight;
    await store.commits;
    store.recovered();
    await store.catchUp();
  } catch (e) {
    if (e.code === 'ESEQ') return open(store, e);
    console.error(`Couldn’t read the store back: ${e.message}`);
    store.rc.backoff = Math.min(Math.max(store.rc.backoff * 2, RETRY_MS), RETRY_MAX);
    store.rc.timer ??= setTimeout(() => {
      store.rc.timer = null;
      reconcile(store);
    }, store.rc.backoff);
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
  if (store.hold && !store.waiting) store.release();
  else store.pump();
}

/** Stops a catch-up waiting to be tried again. @param {Store} store */
export function stopReconciling(store) {
  if (store.rc.timer) clearTimeout(store.rc.timer);
  store.rc.timer = null;
}

/** The status while the store reads Redis back, or null. @param {Store} store */
export function reconcilingStatus(store) {
  if (!store.reconciling || store.redis?.sup.status.state !== 'running') return null;
  return {
    state: 'down',
    cause: 'reconciling',
    message: 'The store’s Redis is back, and Postbox is reading back what it holds before it saves changes again.',
  };
}
