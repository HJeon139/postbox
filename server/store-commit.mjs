// commit(): the store’s authoritative write (#508’s design, “Storage: a Redis 8 server that Postbox bundles and runs”,
// “How it works”; INV-12). Its events are applied to copies of what they touch, the documents that gives are written
// with the events in one script, and only once Redis has replied are the events applied to the state and broadcast. A
// failed write changes nothing anyone can see; a repeated opId writes nothing and returns the earlier seq.
//
// A commit is acknowledged only once Redis has synced it to its append-only file (the person’s decision on #525): after
// the script, `WAITAOF 1 0 WAITAOF_MS` waits for the local fsync, and only then are its events applied and broadcast.
// Emits stay on appendfsync everysec, so a power cut can take up to the last second of them, but no commit anyone saw.
// Redis doesn’t fsync early for WAITAOF: it waits for everysec’s next fsync, up to about a second. A WAITAOF that times
// out, says the local AOF doesn’t hold it, or fails is a lost reply: the commit is in Redis’s memory, maybe not on
// disk, so the commit is refused (ESTOREDOWN), writes close and reconciliation reads Redis back (server/store-recover.mjs);
// a retry with its opId then finds it done.
//
// Commits run one at a time. Emits made while one waits are applied at once, so the server reads its own writes, but
// they’re numbered and broadcast after the commit’s events, and written after it; the commit stages from the state
// before them, and its events are applied to the state before them too (server/store-hold.mjs has the rule).

import { apply, map } from '../shared/state.mjs';
import { storeError } from './redis-client.mjs';
import { Positions, refKey, roundEventCosts, touched, writesFor } from './store-docs.mjs';
import { Hold } from './store-hold.mjs';
import { closeWrites } from './store-recover.mjs';
import { streamAfter, writeBatch } from './store-redis.mjs';

/** @typedef {{ type: string, data: any }[] | ((state: any) => { type: string, data: any }[])} Events */

// How long a commit waits for its local fsync: everysec’s next fsync comes within a second, and Redis may hold the
// write itself back for up to 2 s while a slow fsync runs; past 5 s the disk is in trouble.
export const WAITAOF_MS = 5000;

/**
 * @param {import('./store.mjs').Store} store @param {Events} events @param {string} opId
 * @returns {Promise<{ seq: number, duplicate: boolean }>}
 */
export function commit(store, events, opId) {
  if (store.redis) {
    store.hold ??= new Hold();
    store.waiting++;
  }
  // Emits held behind a commit whose reply was lost stay held until reconciliation has read it back (store-recover.mjs).
  const run = store.commits
    .then(() => commitNow(store, events, opId))
    .finally(() => store.redis && --store.waiting === 0 && !store.reconciling && store.release());
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
    if (!store.redis) return inMemory(store, listOf(events, store.state), opId);
    try {
      return await writeOnce(store, events, opId);
    } catch (e) {
      if (e.code !== 'ESEQ' || attempt >= 20) throw e;
      await store.catchUp();
    }
  }
}

/** A commit’s events, run on the state if they’re a function of it, with their costs rounded. @param {Events} events @param {any} s */
function listOf(events, s) {
  const list = typeof events === 'function' ? events(s) : events;
  for (const e of list) roundEventCosts(e.type, e.data);
  return list;
}

/** @param {import('./store.mjs').Store} store @param {Events} given @param {string} opId */
async function writeOnce(store, given, opId) {
  // A store that can’t write refuses at once, rather than wait on a write in flight (server/store-write.mjs).
  if (!store.writable) throw store.refuse();
  while (store.inflight) await store.inflight;
  if (!store.writable) throw store.refuse();
  // Everything is read from the state before the held emits: the commit comes before them.
  const hold = /** @type {Hold} */ (store.hold);
  const before = hold.view(store.state);
  const events = listOf(given, before);
  // What emits left unwritten goes first, in the same script.
  const pending = store.take(before, hold.itemOf(before, store.itemOf));
  const staged = stage(before, events, store.positions);
  const first = store.state.seq + 1;
  const lines = events.map((e, i) => ({ seq: first + i, line: JSON.stringify({ seq: first + i, type: e.type, data: e.data }) }));
  let r;
  try {
    const writes = [...pending.writes, ...writesFor(staged.state, staged.dirty, staged.itemOf, (t, id) => staged.positions.score(t, id))];
    r = await writeBatch(/** @type {any} */ (store.client), { opId, prev: store.confirmed, events: [...pending.events, ...lines], writes });
  } catch (e) {
    store.untake(pending);
    // The reply was lost, so the commit may be in Redis: no write until catch-up has read it back.
    if (e.code === 'ESTOREDOWN') closeWrites(store);
    throw e;
  }
  try {
    await synced(/** @type {any} */ (store.client));
  } catch (e) {
    // In Redis, maybe not on disk: as a lost reply, nothing is applied until catch-up has read it back.
    store.untake(pending);
    closeWrites(store);
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
  const written = () => {
    for (const e of events) applyWritten(store, e, null);
  };
  if (hold.meets(staged.dirty.map((x) => x.ref))) hold.rebase(store, written);
  else written();
  return r;
}

/**
 * Waits until Redis has synced this connection’s writes to its local append-only file, or throws ESTOREDOWN.
 * @param {import('./redis-client.mjs').RedisClient} c
 */
async function synced(c) {
  let local;
  try {
    [local] = await c.call('WAITAOF', 1, 0, WAITAOF_MS);
  } catch (e) {
    throw storeError('ESTOREDOWN', `Postbox couldn’t confirm the store’s Redis saved this change to disk: ${e.message}`, e);
  }
  if (local < 1) throw storeError('ESTOREDOWN', `The store’s Redis didn’t save this change to disk within ${WAITAOF_MS / 1000} s.`);
}

/**
 * Applies and broadcasts an event Redis already holds: a commit’s, or one read back from the stream.
 * @param {import('./store.mjs').Store} store @param {{ type: string, data: any }} e @param {Positions | null} positions
 */
export function applyWritten(store, e, positions) {
  // Its line is taken before the reducer keeps its objects in the state, where later events change them.
  const seq = store.state.seq + 1;
  const line = JSON.stringify({ seq, type: e.type, data: e.data });
  const refs = touched(store.state, e.type, e.data);
  apply(store.state, e.type, e.data);
  store.track(e.type, e.data, refs);
  positions?.place(refs);
  store.state.seq = seq;
  store.broadcast(seq, line);
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
  const written = () => {
    for (const ev of theirs) {
      const mine = store.lines[0];
      if (mine?.seq === ev.seq && mine.line === JSON.stringify(ev)) store.lines.shift();
      else if (store.state.seq >= ev.seq) {
        store.failed = Object.assign(new Error('Another process wrote to the store’s Redis while this one had changes to write.'), { code: 'ESEQ' });
        return;
      } else applyWritten(store, ev, store.positions);
      store.confirmed = ev.seq;
    }
  };
  // Emits held behind a commit come after these too (server/store-hold.mjs).
  if (store.hold?.emits.length) store.hold.rebase(store, written);
  else written();
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
