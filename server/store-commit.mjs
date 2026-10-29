// commit(): the store’s authoritative write (#508’s design, “Storage: a Redis 8 server that Postbox bundles and runs”,
// “How it works”; INV-12). Its events are applied to copies of what they touch, the documents that gives are written
// with the events in one script, and only once Redis has replied are the events applied to the state and broadcast. A
// failed write changes nothing anyone can see; a repeated opId writes nothing and returns the earlier seq.
//
// Commits run one at a time. Emits made while one waits are applied at once, so the server reads its own writes, but
// they’re numbered and broadcast after the commit’s events, and written after it.

import { apply, map } from '../shared/state.mjs';
import { Positions, refKey, touched, writesFor } from './store-docs.mjs';
import { writeBatch } from './store-redis.mjs';

/**
 * @param {import('./store.mjs').Store} store @param {{ type: string, data: any }[]} events @param {string} opId
 * @returns {Promise<{ seq: number, duplicate: boolean }>}
 */
export function commit(store, events, opId) {
  if (store.redis) {
    store.held ??= [];
    store.waiting++;
  }
  const run = store.commits.then(() => commitNow(store, events, opId)).finally(() => store.redis && --store.waiting === 0 && store.release());
  store.commits = run.catch(() => {});
  return run;
}

/** @param {import('./store.mjs').Store} store @param {{ type: string, data: any }[]} events @param {string} opId */
async function commitNow(store, events, opId) {
  if (!store.redis) return inMemory(store, events, opId);
  await (store.inflight ?? null);
  if (!store.writable) throw store.refuse();
  // What emits left unwritten goes first, in the same script.
  const pending = store.take();
  const staged = stage(store.state, events, store.positions);
  const first = store.state.seq + 1;
  const lines = events.map((e, i) => ({ seq: first + i, line: JSON.stringify({ seq: first + i, type: e.type, data: e.data }) }));
  let r;
  try {
    const writes = [...pending.writes, ...writesFor(staged.state, staged.dirty, staged.itemOf, (t, id) => staged.positions.score(t, id))];
    r = await writeBatch(/** @type {any} */ (store.client), { opId, prev: store.confirmed, events: [...pending.events, ...lines], writes });
  } catch (e) {
    store.untake(pending);
    throw e;
  }
  if (r.duplicate) {
    store.untake(pending);
    return r;
  }
  store.confirmed = r.seq;
  store.positions.merge(staged.positions);
  for (const e of events) applyCommitted(store, e);
  return r;
}

/** @param {import('./store.mjs').Store} store @param {{ type: string, data: any }} e */
function applyCommitted(store, e) {
  const refs = touched(store.state, e.type, e.data);
  apply(store.state, e.type, e.data);
  store.track(e.type, e.data, refs);
  const ev = { seq: ++store.state.seq, type: e.type, data: e.data };
  store.events.push({ seq: ev.seq, line: JSON.stringify(ev) });
  for (const fn of store.listeners) fn(ev);
}

/** @param {import('./store.mjs').Store} store @param {{ type: string, data: any }[]} events @param {string} opId */
function inMemory(store, events, opId) {
  if (opId && store.ops.has(opId)) return { seq: /** @type {number} */ (store.ops.get(opId)), duplicate: true };
  for (const e of events) store.emit(e.type, e.data);
  if (opId) store.ops.set(opId, store.state.seq);
  return { seq: store.state.seq, duplicate: false };
}

/**
 * A commit’s events applied to copies of what they touch, for the documents to write before anything real changes.
 * @param {any} s @param {{ type: string, data: any }[]} events @param {Positions} positions
 */
export function stage(s, events, positions) {
  const state = { ...s, settings: structuredClone(s.settings), items: map({ ...s.items }) };
  const fork = positions.fork();
  const dirty = new Map();
  const copied = new Set();
  events.forEach((e, i) => {
    const refs = touched(state, e.type, e.data);
    for (const r of refs) copyFor(state, r, copied);
    apply(state, e.type, structuredClone(e.data));
    fork.place(refs);
    for (const ref of refs) if (!dirty.has(refKey(ref))) dirty.set(refKey(ref), { ref, seq: s.seq + 1 + i });
  });
  const itemOf = (t, id) => state.items[t]?.find((it) => it.id === id);
  return { state, dirty: [...dirty.values()], itemOf, positions: fork };
}

/** Copies the part of the staged state a ref changes, once. @param {any} state @param {any} r @param {Set<string>} copied */
function copyFor(state, r, copied) {
  const k = r.c === 'items' || r.c === 'itemlist' ? `items:${r.t}` : r.c;
  if (copied.has(k)) return;
  copied.add(k);
  if (r.c === 'items' || r.c === 'itemlist') state.items[r.t] = structuredClone(state.items[r.t] ?? []);
  else if (r.c !== 'settings') state[r.c] = map(structuredClone({ ...state[r.c] }));
}
