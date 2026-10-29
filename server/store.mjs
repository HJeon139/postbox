// Postbox’s store: an in-memory projection of every event, kept in a Redis 8 child process that Postbox runs
// (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”; designs/architecture.md, “The
// store”). Documents are the truth and the `events` stream the sequence, written together (server/store-redis.mjs).
//
// emit() is optimistic: it applies an event with the shared reducer, numbers it and tells subscribers at once, and the
// write follows, one script per tick. commit() is authoritative: its events are written first, and applied and
// broadcast only once Redis has replied; a repeated opId writes nothing twice. While Redis is down, and after a lost
// reply or a restart until the store has read Redis back (server/store-recover.mjs), both refuse (ESTOREDOWN) and the
// state stays readable. A store with no data folder (tests) keeps everything in memory.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, emptyState } from '../shared/state.mjs';
import { storeError } from './redis-client.mjs';
import { catchUp, commit } from './store-commit.mjs';
import { Positions, refKey, roundEventCosts, touched, writesFor } from './store-docs.mjs';
import { Hold } from './store-hold.mjs';
import { importLegacy } from './store-import.mjs';
import { broadcast } from './store-publish.mjs';
import { attach, onStatus, stopReconciling } from './store-recover.mjs';
import { readState, redisFor, releaseRedis, streamAfter } from './store-redis.mjs';
import { statusOf } from './store-status.mjs';
import { pump, recovered } from './store-write.mjs';

export { emptyState };

/** Removes a data folder’s store, for a fresh start: the Redis data and any old log, snapshot or store.json. */
export async function clearStore(dataDir) {
  for (const n of await readdir(dataDir).catch(() => []))
    if (/^(store\.json|snapshot\.json|events-\d+\.jsonl)/.test(n)) await rm(join(dataDir, n), { force: true });
  await rm(join(dataDir, 'redis', 'data'), { recursive: true, force: true });
}

export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8) || Date.now().toString(36)}`;

export class Store {
  /**
   * @param {string|null} dir  the data folder; null keeps everything in memory (tests)
   * @param {{ redisHome?: string, shapes?: import('./store-docs.mjs').Shapes }} [o]  a Redis to run instead of
   *   POSTBOX_REDIS_HOME or the download; the shape to read documents in, for a test of a later one (ST-1)
   */
  constructor(dir, { redisHome, shapes } = {}) {
    this.dir = dir;
    this.redisHome = redisHome;
    this.shapes = shapes;
    this.state = emptyState();
    this.events = [];
    this.listeners = new Set();
    this.positions = new Positions();
    /** @type {Map<string, { t: string, it: any }>} item id → its conversation and the item */
    this.index = new Map();
    /** @type {Map<string, { ref: import('./store-docs.mjs').Ref, seq: number }>} documents to write */
    this.dirty = new Map();
    this.lines = []; // events to append
    this.confirmed = 0; // the seq Redis holds
    this.inflight = null;
    this.scheduled = false;
    this.commits = Promise.resolve();
    /** @type {Hold | null} emits made while a commit waits on Redis (server/store-hold.mjs) */
    this.hold = null;
    this.waiting = 0; // commits not yet answered
    this.ops = new Map(); // in memory only: opId → seq
    /** @type {import('./redis-client.mjs').RedisClient | null} */
    this.client = null;
    /** @type {ReturnType<typeof redisFor> | null} the data folder’s child, once load() started it; null in memory */
    this.redis = null;
    /** @type {Error & { code?: string } | null} why writes stopped: a write Redis failed (ESEQ: until a restart) */
    this.failed = null;
    /** @type {ReturnType<typeof setTimeout> | null} the next try of a failed write */
    this.retry = null;
    this.backoff = 0; // ms before that try; doubles to RETRY_MAX
    this.reconciling = false; // reading Redis back after a lost reply or a restart; writes are closed meanwhile
    /** @type {import('./store-recover.mjs').Reconciler} */
    this.rc = { run: null, again: false, timer: null, backoff: 0 };
    this.closed = false;
    this.watchers = new Set(); // told when writes close or reopen, and what they last heard (server/store-status.mjs)
    this.seen = '';
  }

  async load() {
    if (!this.dir) return this;
    await mkdir(this.dir, { recursive: true });
    this.redis = redisFor(this.dir, { home: this.redisHome });
    const sup = await this.redis.ready;
    const client = await sup.client();
    attach(this, client);
    sup.on('status', (s) => this.onStatus(s));
    await importLegacy(this.dir, client);
    const { state, positions } = await readState(client, this.shapes);
    this.state = state;
    this.positions = positions;
    this.confirmed = state.seq;
    for (const [t, list] of Object.entries(state.items)) for (const it of list) this.index.set(it.id, { t, it });
    return this;
  }

  /** The child went down or came back: writes close until the store has read Redis back (server/store-recover.mjs). */
  onStatus(s) {
    onStatus(this, s);
  }

  /** Whether a write can be accepted now. */
  get writable() {
    return !this.redis || (!!this.client?.connected && this.redis?.sup.status.state === 'running' && !this.failed && !this.reconciling);
  }

  /** The status for the page: running exactly when writable; otherwise down, with its cause (server/store-status.mjs). */
  get status() {
    return statusOf(this);
  }

  refuse() {
    const why = this.failed?.message ?? /** @type {any} */ (this.status).message ?? 'The store’s Redis isn’t answering.';
    return storeError('ESTOREDOWN', `Postbox can’t save changes right now, so it didn’t make this one. ${why}`);
  }

  /** Applies a change and broadcasts it, then writes it. The shared reducer is the only place state changes. */
  emit(type, data) {
    if (!this.writable) throw this.refuse();
    roundEventCosts(type, data);
    const refs = this.redis ? touched(this.state, type, data) : [];
    this.hold?.save(this.state, refs);
    apply(this.state, type, data);
    this.track(type, data, refs);
    const ev = { seq: 0, type, data };
    // The reducer keeps an event’s objects in the state, where later events change them in place, so the backlog
    // keeps each event as JSON: a reconnecting browser gets it as it was emitted, not as the state is now.
    const json = JSON.stringify(data);
    if (this.hold) this.hold.emits.push({ ev, json, refs });
    else this.publish(ev, json, refs);
    return ev;
  }

  /** Numbers an applied event, tells subscribers, and queues its write. */
  publish(ev, json, refs) {
    ev.seq = ++this.state.seq;
    const line = `{"seq":${ev.seq},"type":${JSON.stringify(ev.type)},"data":${json}}`;
    this.broadcast(ev.seq, line);
    if (!this.redis) return;
    this.lines.push({ seq: ev.seq, line });
    this.positions.place(refs);
    for (const ref of refs) this.mark(ref, ev.seq);
    this.schedule();
  }

  /** Keeps an event for replay and tells subscribers, from its line (server/store-publish.mjs). @param {number} seq @param {string} line */
  broadcast(seq, line) {
    broadcast(this, seq, line);
  }

  /** @param {import('./store-docs.mjs').Ref} ref @param {number} seq */
  mark(ref, seq) {
    const k = refKey(ref);
    const had = this.dirty.get(k);
    // A collection keeps first-insertion order, so its first seq places it; a boilerplate moves to the end.
    this.dirty.set(k, { ref, seq: had && !('move' in ref && ref.move) ? had.seq : seq });
  }

  /** Keeps the item index current. */
  track(type, d, refs) {
    if (type === 'item.add') this.index.set(d.item.id, { t: d.threadId, it: d.item });
    if (type === 'item.move' && d.stub) this.index.set(d.stub.id, { t: d.threadId, it: d.stub });
    for (const r of refs) if (r.c === 'itemlist') for (const id of r.ids) this.index.delete(id);
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  /** The item in conversation t now, for writing it. @param {string} t @param {string} id */
  itemOf = (t, id) => {
    const e = this.index.get(id);
    return e && e.t === t && this.state.items[t]?.includes(e.it) ? e.it : undefined;
  };

  /**
   * Takes what waits to be written: its events and the writes for its documents as they are now, or as they are in
   * `s`, the state before held emits (server/store-hold.mjs).
   */
  take(s = this.state, itemOf = this.itemOf) {
    const events = this.lines.splice(0);
    const dirty = [...this.dirty.values()];
    this.dirty.clear();
    return { events, dirty, writes: writesFor(s, dirty, itemOf, (t, id) => this.positions.score(t, id)) };
  }

  /** Puts a batch that wasn’t written back in front of what waits. */
  untake({ events, dirty }) {
    this.lines.unshift(...events);
    const later = [...this.dirty.entries()];
    this.dirty = new Map(dirty.map((x) => [refKey(x.ref), x]));
    for (const [k, v] of later) if (!this.dirty.has(k)) this.dirty.set(k, v);
  }

  /** Writes what waits, one batch at a time (server/store-write.mjs). @param {boolean} [retrying] a failed batch’s retry */
  pump(retrying = false) {
    pump(this, retrying);
  }

  /** Ends the failed state: a write succeeded, or the child started again. */
  recovered() {
    recovered(this);
  }

  /** Waits for every event emitted so far to reach Redis, or for the store to be unable to write it. */
  async flush() {
    if (!this.redis) return;
    while (this.inflight || this.scheduled || (this.lines.length && this.client?.connected && !this.failed && !this.hold && !this.reconciling)) {
      this.pump();
      await (this.inflight ?? new Promise((ok) => setImmediate(ok)));
    }
    await this.commits;
  }

  /**
   * Writes events as one transaction, then applies and broadcasts them: if the write fails, nothing was applied or
   * seen. A repeated opId writes nothing and returns the seq it ended at the first time (server/store-commit.mjs).
   * @param {import('./store-commit.mjs').Events} events  or a function of the state that gives them, run again if
   *   another process wrote first  @param {string} [opId]
   * @returns {Promise<{ seq: number, duplicate: boolean }>}
   */
  commit(events, opId) {
    return commit(this, events, opId ?? '');
  }

  /** Applies what another process, or a write whose reply was lost, put in Redis past what this store knows. */
  catchUp() {
    return catchUp(this);
  }

  /** Publishes the emits a commit held, after its own events. */
  release() {
    const held = this.hold?.emits ?? [];
    this.hold = null;
    for (const h of held) this.publish(h.ev, h.json, h.refs);
    this.pump();
  }

  /** Events after `seq` kept in memory, or null when they’re no longer kept and the client must refetch the state. */
  since(seq) {
    if (seq >= this.state.seq) return [];
    const first = this.events[0]?.seq ?? this.state.seq + 1;
    if (seq + 1 < first) return null;
    return this.events.filter((e) => e.seq > seq).map((e) => JSON.parse(e.line));
  }

  /** Events after `seq`, from memory or else from the stream; null when the stream was trimmed past them. */
  async backlog(seq) {
    const kept = this.since(seq);
    if (kept || !this.client?.connected) return kept;
    const first = this.events[0]?.seq ?? this.state.seq + 1;
    const older = await streamAfter(this.client, seq, first - 1);
    return older && [...older, ...this.events.map((e) => JSON.parse(e.line))];
  }

  /** Kept for callers of the log-and-snapshot store: documents are always current, so it only waits for writes. */
  snapshot() {
    return this.flush();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The bytes the store’s append-only files take. */
  async size() {
    if (!this.dir) return 0;
    const dir = join(this.dir, 'redis', 'data', 'appendonly');
    let total = 0;
    for (const n of await readdir(dir).catch(() => [])) total += (await stat(join(dir, n))).size;
    return total;
  }

  /** Writes what waits, then lets go of the child; the last store on a data folder stops it. */
  async close() {
    if (!this.redis || !this.dir) return;
    await this.flush();
    this.closed = true;
    stopReconciling(this);
    const failed = this.failed;
    this.recovered();
    if (this.lines.length)
      console.error(
        `The store couldn’t save the last ${this.lines.length} changes before Postbox stopped: ${failed?.message ?? 'its Redis wasn’t answering.'}`,
      );
    this.client?.close();
    this.client = null;
    await releaseRedis(this.dir);
  }

  // Read helpers
  items(threadId) {
    return this.state.items[threadId] ?? [];
  }
  item(threadId, id) {
    return this.items(threadId).find((i) => i.id === id);
  }
  findItem(id) {
    for (const [threadId, list] of Object.entries(this.state.items)) {
      const it = list.find((i) => i.id === id);
      if (it) return { threadId, item: it };
    }
    return null;
  }
}
