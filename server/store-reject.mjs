// A batch the store’s Redis refuses for a reason no retry changes: a document RedisJSON won’t hold, a key of the wrong
// type, a script error (gpt’s r2 review of #553, blocker 1; #508’s design, “Storage”, decision 7). The store checks every
// event’s JSON before it’s applied (server/store-check.mjs), so this is for what it can’t know up front.
//
// The batch’s events were applied and broadcast before Redis saw them (server/store.mjs, emit()), so memory and the
// pages hold a change Redis won’t keep. Dropping the batch and writing on would let a later write certify a state Redis
// never held, and lose the batch’s other events too; trying it again on a timer would refuse the same write forever. So
// the store fails closed, as for any failed write: writable is false, the status says which changes may be the one
// refused, the batch stays queued, in order, and nothing is tried again until the person acts.
//
// Retry repairs it. First the queued events are written one at a time, each with the documents only it touches, so an
// event Redis takes is saved; one Redis refuses marks its documents refused, and a later event touching them is refused
// with it, since the document can’t be stored. Then the store reads Redis back and replaces its state with what Redis
// holds (documents are the truth), tells every page to resync, and writes again. The refused changes are gone from
// memory as from Redis; the status carries them as `dropped`, which the page shows as a notice. Closing the store does
// the first half, so a restart loses nothing Redis would take; the restart itself reads Redis back. A child that restarts
// while a batch is refused writes it once more, and is refused once more, so the person decides.

import { storeError } from './redis-client.mjs';
import { refKey, writesFor } from './store-docs.mjs';
import { readState, writeBatch } from './store-redis.mjs';
import { changed } from './store-status.mjs';

/** Why a write failed when a retry can change it: the connection, or Redis short of memory, loading or busy. */
export const TRANSIENT = new Set(['ESTOREDOWN', 'EPROTO', 'ESEQ', 'OOM', 'LOADING', 'BUSY', 'MISCONF', 'TRYAGAIN', 'READONLY', 'NOREPLICAS', 'MASTERDOWN']);

/** @typedef {import('./store.mjs').Store} Store */
/** @typedef {{ seq: number, line: string, refs?: import('./store-docs.mjs').Ref[] }} Line */

/**
 * Fails closed on a batch Redis refused for good: the batch goes back in front of what waits, and the status says why
 * and which changes it holds.
 * @param {Store} store @param {{ events: Line[], dirty: { ref: import('./store-docs.mjs').Ref, seq: number }[] }} batch
 * @param {Error & { code?: string }} e
 */
export function reject(store, batch, e) {
  store.untake(batch);
  const changes = batch.events.map(describe);
  const n = changes.length;
  store.rejected = { at: Date.now(), changes, message: e.message };
  store.failed = storeError(
    'EREJECTED',
    `The store’s Redis refused a write for a reason a retry can’t change: ${e.message} ${n === 1 ? 'This change is' : `One or more of these ${n} changes are`} shown but not saved: ${changes.join('; ')}. Retry saves the changes Redis takes and shows what it holds; so does starting Postbox again.`,
    e,
  );
  console.error(`${store.failed.message} Postbox stopped saving changes until then.`);
  changed(store);
}

/** The store’s status while a batch is refused: down, with the cause the page shows. @param {Store} store */
export function rejectedStatus(store) {
  return { state: 'down', cause: 'rejected', message: store.failed?.message ?? '' };
}

/**
 * One queued event, named for the status: its type and the ids it’s about, never its text.
 * @param {Line} l
 */
export function describe(l) {
  /** @type {{ seq: number, type: string, data: any }} */
  const { seq, type, data } = JSON.parse(l.line);
  const d = data ?? {};
  const about = [d.item?.kind, d.item?.id ?? d.id ?? d.convId, d.threadId && `in ${d.threadId}`].filter((x) => typeof x === 'string').join(' ');
  return `${seq}: ${type}${about ? ` ${about}` : ''}`;
}

/**
 * Writes what waits one event at a time, each with the documents only it touches, so the events Redis takes are saved
 * and the ones it refuses are known. An event is refused with any document it touches that Redis refused before it. A
 * failure a retry can change puts what’s left back and throws: the store is failed as for any such write.
 * @param {Store} store
 * @returns {Promise<{ rejected: Line[], documents: number, message: string }>}
 */
export async function salvage(store) {
  const batch = store.take();
  const byKey = new Map(batch.dirty.map((x) => [refKey(x.ref), x]));
  const refused = new Set();
  const written = new Set();
  const rejected = [];
  let message = store.rejected?.message ?? '';
  for (let i = 0; i < batch.events.length; i++) {
    const ev = batch.events[i];
    const keys = (ev.refs ?? []).map(refKey);
    if (keys.some((k) => refused.has(k))) {
      rejected.push(ev);
      continue;
    }
    const dirty = [...new Set(keys)]
      .filter((k) => !written.has(k))
      .map((k) => byKey.get(k) ?? { ref: /** @type {any} */ (ev.refs?.find((r) => refKey(r) === k)), seq: ev.seq });
    try {
      const writes = writesFor(store.state, dirty, store.itemOf, (t, id) => store.positions.score(t, id));
      const r = await writeBatch(/** @type {any} */ (store.client), { prev: store.confirmed, events: [{ seq: ev.seq, line: ev.line }], writes });
      store.confirmed = r.seq;
      for (const k of keys) written.add(k);
    } catch (e) {
      if (TRANSIENT.has(e.code)) {
        store.untake({ events: [...rejected, ...batch.events.slice(i)], dirty: batch.dirty.filter((x) => !written.has(refKey(x.ref))) });
        throw e;
      }
      for (const k of keys) refused.add(k);
      rejected.push(ev);
      message = e.message;
    }
  }
  return { rejected, documents: refused.size, message };
}

/**
 * Closing a store with a refused batch: the events Redis takes are saved, so a restart, which reads Redis back, loses
 * only what Redis refused; those are logged. A failure a retry can change leaves the rest queued, and close() logs them.
 * @param {Store} store
 */
export async function closeRejected(store) {
  if (!store.client?.connected) return;
  try {
    const { rejected, message } = await salvage(store);
    if (rejected.length)
      console.error(
        `The store’s Redis refused ${rejected.length} change(s) for a reason a retry can’t change, so they weren’t saved: ${rejected.map(describe).join('; ')}. ${message} Postbox saved the other changes that waited.`,
      );
  } catch (e) {
    store.failed = e;
  }
}

/**
 * Retry on a refused batch: saves what Redis takes, then reads Redis back so memory is what’s saved, and writes again.
 * What Redis refused is reported as `dropped`. A failure a retry can change leaves the store failed with that cause.
 * @param {Store} store
 */
export async function repair(store) {
  if (store.failed?.code !== 'EREJECTED' || !store.client?.connected) return;
  store.reconciling = true;
  changed(store);
  try {
    await store.inflight;
    await store.commits;
    const { rejected, documents, message } = await salvage(store);
    const { state, positions } = await readState(store.client, store.shapes);
    reload(store, state, positions);
    const seqs = rejected.map((x) => x.seq);
    store.dropped = {
      at: Date.now(),
      events: seqs.length,
      from: seqs[0] ?? null,
      to: seqs.at(-1) ?? null,
      documents,
      message,
      changes: rejected.map(describe),
    };
    if (!seqs.length) store.dropped = null;
    store.rejected = null;
    store.failed = null;
    console.error(
      seqs.length
        ? `The store’s Redis refused ${seqs.length} change(s) for a reason a retry can’t change, so they weren’t saved: ${store.dropped?.changes.join('; ')}. ${message} Postbox saved the other changes that waited and now shows what Redis holds.`
        : 'The store’s Redis took on Retry what it had refused; Postbox saved what waited and shows what Redis holds.',
    );
  } catch (e) {
    // What’s left waits, as for any failed write: the status says what to do, from its cause.
    console.error(`Couldn’t repair the store after a refused write: ${e.message}`);
    store.failed = e;
    store.reconciling = false;
    changed(store);
    return;
  }
  store.reconciling = false;
  for (const fn of store.reloads) fn(); // the pages load the state again, then hear the status
  if (store.hold && !store.waiting) store.release();
  else store.pump();
  changed(store);
}

/**
 * Replaces the store’s memory with what Redis holds: the state, the items’ positions and the index, with nothing queued
 * and no backlog, since the pages must load the state again rather than replay events.
 * @param {Store} store @param {any} state @param {import('./store-docs.mjs').Positions} positions
 */
function reload(store, state, positions) {
  store.state = state;
  store.positions = positions;
  store.confirmed = state.seq;
  store.index = new Map();
  for (const [t, list] of Object.entries(state.items)) for (const it of list) store.index.set(it.id, { t, it });
  store.lines = [];
  store.dirty.clear();
  store.events.length = 0;
}
