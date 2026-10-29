// commit(): the store’s authoritative write (#508’s design, “Storage: a Redis 8 server that Postbox bundles and runs”,
// “How it works”; INV-12). Its events are applied to copies of what they touch, the documents that gives are written
// with the events in one script, and only once Redis has replied are the events applied to the state and broadcast. A
// failed write changes nothing anyone can see; a repeated opId writes nothing and returns the earlier seq.
//
// Commits run one at a time. Emits made while one waits are applied at once, so the server reads its own writes, but
// they’re numbered and broadcast after the commit’s events, and written after it.

import { apply, map } from '../shared/state.mjs';
import { Positions, refKey, roundEventCosts, touched, writesFor } from './store-docs.mjs';
import { streamAfter, writeBatch } from './store-redis.mjs';

/** @typedef {{ type: string, data: any }[] | ((state: any) => { type: string, data: any }[])} Events */

/**
 * @param {import('./store.mjs').Store} store @param {Events} events @param {string} opId
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

/**
 * Runs a commit. Events may be a function of the state, as a transition is: when another process wrote first (ESEQ),
 * the store catches up from the stream and the function runs again on the new state.
 * @param {import('./store.mjs').Store} store @param {Events} events @param {string} opId
 */
async function commitNow(store, events, opId) {
  for (let attempt = 0; ; attempt++) {
    const list = typeof events === 'function' ? events(store.state) : events;
    for (const e of list) roundEventCosts(e.type, e.data);
    if (!store.redis) return inMemory(store, list, opId);
    try {
      return await writeOnce(store, list, opId);
    } catch (e) {
      if (e.code !== 'ESEQ' || attempt >= 20) throw e;
      await store.catchUp();
    }
  }
}

/** @param {import('./store.mjs').Store} store @param {{ type: string, data: any }[]} events @param {string} opId */
async function writeOnce(store, events, opId) {
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
    // It ran before: maybe its reply was lost when Redis stopped. Its events are in the stream; catch up to them.
    store.untake(pending);
    if (r.seq > store.confirmed) await store.catchUp();
    return r;
  }
  store.confirmed = r.seq;
  store.positions.merge(staged.positions);
  for (const e of events) applyWritten(store, e, null);
  return r;
}

/**
 * Applies and broadcasts an event Redis already holds: a commit’s, or one read back from the stream.
 * @param {import('./store.mjs').Store} store @param {{ type: string, data: any }} e @param {Positions | null} positions
 */
export function applyWritten(store, e, positions) {
  const refs = touched(store.state, e.type, e.data);
  apply(store.state, e.type, e.data);
  store.track(e.type, e.data, refs);
  positions?.place(refs);
  const ev = { seq: ++store.state.seq, type: e.type, data: e.data };
  store.events.push({ seq: ev.seq, line: JSON.stringify(ev) });
  for (const fn of store.listeners) fn(ev);
}

/**
 * Brings the store up to what Redis holds. Events past `confirmed` that this store sent itself (a reply lost when Redis
 * stopped) are dropped from what waits; any others another process wrote are applied and broadcast. When this store
 * has emits of its own numbered past them, it can’t renumber what browsers saw, so it stops writing (fails closed).
 * @param {import('./store.mjs').Store} store
 */
export async function catchUp(store) {
  const c = store.client;
  if (!c?.connected) return;
  const seq = Number((await c.call('GET', 'seq')) ?? 0);
  if (seq <= store.confirmed) return;
  const theirs = await streamAfter(c, store.confirmed, seq);
  if (!theirs) throw Object.assign(new Error('The store’s events stream was trimmed past this store; restart Postbox to read it again.'), { code: 'ESEQ' });
  for (const ev of theirs) {
    const mine = store.lines[0];
    if (mine?.seq === ev.seq && mine.line === JSON.stringify(ev)) store.lines.shift();
    else if (store.state.seq >= ev.seq) {
      store.failed = Object.assign(new Error('Another process wrote to the store’s Redis while this one had changes to write.'), { code: 'ESEQ' });
      return;
    } else applyWritten(store, ev, store.positions);
    store.confirmed = ev.seq;
  }
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

/**
 * Copies, once, what a ref lets the reducer change in the staged state: the one record, or the conversation’s list
 * (a shallow copy) and the one item in it. Everything else stays shared with the real state, unchanged.
 * @param {any} state @param {any} r @param {Set<string>} copied
 */
function copyFor(state, r, copied) {
  const once = (k, fn) => {
    if (!copied.has(k)) {
      copied.add(k);
      fn();
    }
  };
  if (r.c === 'settings') return;
  if (r.c === 'items' || r.c === 'itemlist') {
    once(`list:${r.t}`, () => {
      state.items[r.t] = [...(state.items[r.t] ?? [])];
    });
    if (r.c === 'items')
      once(`item:${r.id}`, () => {
        const list = state.items[r.t];
        const k = list.findIndex((it) => it.id === r.id);
        if (k >= 0) list[k] = structuredClone(list[k]);
      });
    return;
  }
  once(`map:${r.c}`, () => {
    state[r.c] = map({ ...state[r.c] });
  });
  once(`${r.c}:${r.id}`, () => {
    if (state[r.c][r.id] !== undefined) state[r.c][r.id] = structuredClone(state[r.c][r.id]);
  });
}
