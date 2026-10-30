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
// Retry repairs it. The store reads Redis back, and replays the queued events on that state one by one, asking Redis
// before each (a probe that stages its documents and commits nothing, server/store-redis.mjs) whether it would hold the
// documents the event leaves; one Redis refuses is undone in the replay and marks its documents refused, and a later
// event touching them is refused with it, since the document can’t be stored. The events Redis takes are then written
// in one batch, from the replayed state, so what’s written is exactly what those events in the stream replay to, and
// no crash can leave Redis holding some of them with documents from the rest (gpt’s r4 review of #553). Then the store
// reads Redis back and replaces its state with what Redis holds (documents are the truth), tells every page to resync,
// and writes again. The refused changes are gone from memory as from Redis; the status carries them as `dropped`, which
// the page shows as a notice. Closing the store does the first half, so a restart loses nothing Redis would take; the
// restart itself reads Redis back. A child that restarts while a batch is refused writes it once more, and is refused
// once more, so the person decides.

import { apply } from '../shared/state.mjs';
import { storeError } from './redis-client.mjs';
import { refKey, touched, writesFor } from './store-docs.mjs';
import { Hold } from './store-hold.mjs';
import { probeWrites, readState, writeBatch } from './store-redis.mjs';
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
 * Saves the queued events Redis takes, in one write, and tells which it refused. The queue is replayed on the state
 * Redis holds (triage()), and the events Redis takes are written as one batch from the replayed state, so the documents
 * Redis commits are what the stream’s events replay to at every point. A failure a retry can change puts the whole
 * queue back and throws: the store is failed as for any such write. Nothing is left half-written: before the one write,
 * Redis is as it was.
 * @param {Store} store
 * @returns {Promise<{ rejected: Line[], documents: number, message: string }>}
 */
export async function salvage(store) {
  const client = /** @type {import('./redis-client.mjs').RedisClient} */ (store.client);
  const batch = store.take();
  const back = (e) => {
    store.untake(batch);
    throw e;
  };
  const { state: s, positions } = await readState(client, store.shapes).catch(back);
  if (s.seq !== store.confirmed) back(storeError('ESEQ', `The store’s Redis is at event ${s.seq}, not ${store.confirmed}: another process wrote to it.`));
  const { accepted, rejected, dirty, refused, message } = await triage(client, s, positions, batch.events, store.rejected?.message ?? '').catch(back);
  if (accepted.length) {
    const writes = writesFor(s, dirty.values(), itemIn(s), (t, id) => positions.score(t, id));
    try {
      const r = await writeBatch(client, { prev: store.confirmed, events: accepted.map(({ seq, line }) => ({ seq, line })), writes });
      store.confirmed = r.seq;
    } catch (e) {
      // Probed and still refused: something the probe can’t see. Fail closed as before, so Retry can try once more.
      back(
        TRANSIENT.has(e.code) ? e : storeError('EREJECTED', `The store’s Redis refused the changes it had agreed to take: ${e.message} Retry tries again.`, e),
      );
    }
  }
  return { rejected, documents: refused.size, message };
}

/** The item of conversation t in a state, for writing it. @param {any} s */
const itemIn = (s) => (t, id) => s.items[t]?.find((it) => it.id === id);

/**
 * Replays the queued events on `s`, the state Redis holds, one by one: each is applied, and Redis asked whether it
 * would hold the documents it leaves (probeWrites, which commits nothing); one Redis refuses is undone, its documents
 * are marked refused, and an event touching them after it is refused with it. Leaves `s` and `positions` as the
 * accepted events make them, with the documents they touch, placed as Store.mark() places them. A failure a retry can
 * change is thrown as it is.
 * @param {import('./redis-client.mjs').RedisClient} client @param {any} s @param {import('./store-docs.mjs').Positions} positions
 * @param {Line[]} events @param {string} message  the refusal so far
 */
async function triage(client, s, positions, events, message) {
  const refused = new Set();
  /** @type {Line[]} */ const rejected = [];
  /** @type {Line[]} */ const accepted = [];
  /** @type {Map<string, { ref: import('./store-docs.mjs').Ref, seq: number }>} */ const dirty = new Map();
  for (const ev of events) {
    const { type, data } = JSON.parse(ev.line);
    const refs = touched(s, type, data);
    const keys = refs.map(refKey);
    if (keys.some((k) => refused.has(k))) {
      rejected.push(ev);
      continue;
    }
    const before = new Hold();
    before.save(s, refs);
    const placed = positions.fork();
    placed.place(refs);
    apply(s, type, data);
    const own = [...new Map(refs.map((r) => [refKey(r), { ref: r, seq: ev.seq }])).values()];
    try {
      await probeWrites(
        client,
        writesFor(s, own, itemIn(s), (t, id) => placed.score(t, id)),
      );
    } catch (e) {
      before.into(s);
      if (TRANSIENT.has(e.code)) throw e;
      for (const k of keys) refused.add(k);
      rejected.push(ev);
      message = e.message;
      continue;
    }
    positions.merge(placed);
    accepted.push(ev);
    for (const r of refs) {
      const k = refKey(r);
      const had = dirty.get(k);
      dirty.set(k, { ref: r, seq: had && !('move' in r && r.move) ? had.seq : ev.seq });
    }
  }
  return { accepted, rejected, dirty, refused, message };
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
