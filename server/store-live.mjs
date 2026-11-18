// Live frames through the store (designs/architecture/live-progress.md, “Order”): a running turn’s progress, sent to
// the pages unstored. An emit made while a commit is queued or in flight, or a snapshot is written, is held in one
// FIFO and released in its turn (server/store.mjs); a live frame made then joins that FIFO as an unnumbered job, so
// the pages hear stored events and live frames in the order they were made. When it comes out it’s heard, never
// numbered, applied or written. While any waits (store.heldLive), an emit is held behind it too (Store.emit), so a
// stored write can’t overtake it. A reload drops the waiting frames with the queue (store-recover.mjs): the pages
// load the state again.

/**
 * Sends a live frame to the store’s live listeners: now, or in its turn behind what the store holds.
 * @param {any} store  a Store @param {any} frame
 */
export function sendLive(store, frame) {
  if (store.retiring) return;
  const holding = store.waitingCommits || store.held || store.heldLive || store.snapshotting;
  if (holding && (store.writable || store.reconciling)) {
    store.heldLive = (store.heldLive ?? 0) + 1;
    store.queue.push({ live: frame });
    store.pump();
    return;
  }
  hearLive(store, frame);
}

/** Listens for a store’s live frames; returns how to stop. @param {any} store @param {(frame: any) => void} fn */
export function onLive(store, fn) {
  store.liveListeners ??= new Set();
  store.liveListeners.add(fn);
  return () => store.liveListeners.delete(fn);
}

/** A waiting live frame, released in its turn, or by a write that failed. @param {any} store @param {{ live: any }} job */
export function releaseLive(store, job) {
  store.heldLive--;
  hearLive(store, job.live);
}

/** @param {any} store @param {any} frame */
function hearLive(store, frame) {
  for (const fn of store.liveListeners ?? []) fn(frame);
}

/**
 * Listens for a store’s session writes as each is made, before it’s emitted, held or not: a running turn’s buffer
 * takes a stored write of a live field then, and sends its waiting frame ahead of it (server/live-buffer.mjs).
 * It hears the write’s data, and the change asked for: a field equal to what’s stored is in the change but not the
 * data, and a running turn may hold another value of it live.
 * @param {any} store @param {(data: { id: string, patch: Record<string, any>, unset?: string[] }, asked: Record<string, any>) => void} fn
 */
export function onSessionWrite(store, fn) {
  store.sessionWriters ??= new Set();
  store.sessionWriters.add(fn);
}

/**
 * A session write about to be emitted (server/sessions.mjs, update), with the change it was asked for.
 * @param {any} store @param {any} data @param {Record<string, any>} [asked]
 */
export function sessionWriting(store, data, asked = data.patch) {
  for (const fn of store.sessionWriters ?? []) fn(data, asked);
}

/**
 * Listens for a reply about to settle: a patch of a streaming reply that sets another status, before it’s emitted.
 * A running turn’s words held for it are stored first, so item.final reads them whole (server/live-text.mjs).
 * @param {any} store @param {(threadId: string, id: string) => void} fn
 */
export function onItemSettle(store, fn) {
  store.itemSettlers ??= new Set();
  store.itemSettlers.add(fn);
}

/** A reply about to settle (server/threads.mjs, patchItem). @param {any} store @param {string} threadId @param {string} id */
export function itemSettling(store, threadId, id) {
  for (const fn of store.itemSettlers ?? []) fn(threadId, id);
}
