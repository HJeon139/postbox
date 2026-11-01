// Postbox’s store: an append-only event log (JSON Lines) plus periodic snapshots, with all reads served
// from an in-memory projection. See designs/architecture.md, “The store”, and #508’s storage design.
//
// Every change goes through emit(), one event applied, numbered, appended and told at once, or commit(), several
// events written as ONE fsynced line and applied only once the disk has them (server/store-commit.mjs). Both number
// their events through sequence(), the one place a seq is assigned. A browser that reconnects asks for everything
// after the last number it saw, so nothing is lost or duplicated. A write that fails closes the store to commits
// (server/store-commit.mjs, fail); restarting Postbox is the recovery, since load() handles whatever the disk holds.
//
//   <dir>/snapshot.json          the state as of some sequence number (written atomically)
//   <dir>/events-<from>.jsonl    events after that, one per line, or one commit’s events per line (shared/log-lines.mjs);
//                                a new segment starts at each snapshot
//   <dir>/store.lock             the process whose store holds the folder (server/store-lock.mjs)
//
// Every file access goes through this.io (node:fs/promises unless a test gives one), so a test can fail one operation.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { apply, emptyState } from '../shared/state.mjs';
import { commit, run, syncDir } from './store-commit.mjs';
import { lockStore, unlockStore } from './store-lock.mjs';
import { install, recover } from './store-recover.mjs';

export { emptyState };

const KEEP_EVENTS = 20000; // events kept in memory for reconnecting browsers
const SNAPSHOT_EVERY = 5000; // events between snapshots

export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8) || Date.now().toString(36)}`;

export class Store {
  /**
   * @param {string|null} dir  the data folder; null keeps everything in memory (tests)
   * @param {{ snapshotEvery?: number, io?: typeof fs }} [options]  `io` stands in for node:fs/promises
   */
  constructor(dir, { snapshotEvery = SNAPSHOT_EVERY, io = fs } = {}) {
    this.dir = dir;
    this.io = io;
    this.snapshotEvery = snapshotEvery;
    this.state = emptyState();
    this.events = []; // the backlog for reconnecting browsers: { seq, line }
    // The history the seqs count within: a token new at each load(), so a page from before, whose seq may
    // name events this store never kept, is told to resync whatever its seq (server/live-streams.mjs).
    this.epoch = this.newEpoch();
    this.listeners = new Set();
    // The writer’s jobs (server/store-commit.mjs), in order: a line to append, a held emit, a commit, a flush or a
    // snapshot; its loop, while one runs; and the generation a loop runs as (1b’s Retry bumps it to fence a loop).
    this.queue = [];
    this.running = null;
    this.generation = 0;
    this.segment = 'events-1.jsonl'; // the current log file; load() picks the real one
    this.freshSegment = false; // the segment is a file the writer made, whose folder isn’t synced yet
    /** @type {import('node:fs/promises').FileHandle | null} the segment, open for appending */
    this.fh = null;
    this.sinceSnapshot = 0;
    this.ops = new Map(); // opId → the seq of its commit’s last event, for the commits since the latest snapshot
    this.ahead = 0; // events numbered but not yet applied: a commit’s, before its fsync
    this.waitingCommits = 0; // commits queued or pending; emits are held behind them
    this.held = 0; // emits held in the queue, still to be numbered
    this.lock = null; // the folder’s lock while this store holds it (server/store-lock.mjs)
    // Writes are open, or closed with the cause after a write failed: commits are refused until Postbox restarts
    // (#508’s storage design, “When a write fails”; Retry as a reload is 1b’s).
    this.writable = true;
    /** @type {(Error & { code?: string }) | null} why writes are closed */
    this.cause = null;
    this.warned = false; // an emit while closed logged the cause
    this.lost = null; // history the log lost, { from, to, count }, found at load (server/store-replay.mjs)
    this.closed = false; // close() ran: nothing is applied or written here again
    this.closing = false; // close() has begun: no commit or emit is taken, no snapshot renames or prunes
  }

  newEpoch() {
    return newId('ep');
  }

  /** Takes the folder (one store per folder, or load() rejects naming the holder), reads it, and leaves the writer at its end. */
  async load({ fresh = false } = {}) {
    if (!this.dir) {
      this.epoch = this.newEpoch();
      return this;
    }
    await this.io.mkdir(this.dir, { recursive: true });
    this.lock = await lockStore(this.io, this.dir);
    try {
      // A fresh start empties the folder only once it holds the lock, so a running Postbox’s files are never deleted
      // under it (the integrator’s review of 1a).
      if (fresh)
        for (const n of await this.io.readdir(this.dir))
          if (/^(store\.json|snapshot\.json|events-\d+\.jsonl)/.test(n)) await this.io.rm(this.at(n), { force: true });
      install(this, await recover(this));
      // The folder’s entries are made durable once per start: a segment rotated by an earlier run that only ever held
      // emits may never have had its entry synced (the integrator’s review of 1a). A filesystem that can’t sync a
      // folder is tolerated; any other error refuses the start.
      await syncDir(this);
    } catch (e) {
      await unlockStore(this.io, this.lock);
      this.lock = null;
      throw e;
    }
    return this;
  }

  /** A path in the data folder. Only the disk-backed paths call this, after checking there is one. */
  at(name) {
    return join(/** @type {string} */ (this.dir), name);
  }

  async segments() {
    if (!this.dir) return [];
    return (await this.io.readdir(this.dir))
      .filter((n) => /^events-\d+\.jsonl$/.test(n))
      .map((name) => ({ name, from: Number(name.slice(7, -6)) }))
      .sort((a, b) => a.from - b.from);
  }

  /**
   * Numbers an event: the ONE place a seq is assigned, for emit() and commit() alike, in the order the writer takes
   * them. (#508’s delivery number `n`, PR 1b, will be assigned here too.) The event is applied later, by record().
   */
  sequence(ev) {
    ev.seq = this.state.seq + ++this.ahead;
    return ev;
  }

  /** Applies a numbered event with the shared reducer, the only place state changes, and keeps it for since(). */
  record(ev) {
    // The reducer keeps an event’s objects in the state, where later events change them in place, so the backlog
    // keeps each event as JSON: a reconnecting browser gets it as it was emitted, not as the state is now.
    const line = JSON.stringify(ev);
    apply(this.state, ev.type, ev.data);
    this.state.seq = ev.seq;
    this.ahead--;
    this.events.push({ seq: ev.seq, line });
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
    return line;
  }

  notify(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  /**
   * Applies a change and broadcasts it, unless a commit is queued or in flight: then it’s held, and numbered, applied
   * and broadcast in its turn once the commit resolves or fails (the returned event gets its seq then). While writes
   * are closed it’s applied and broadcast but not written.
   */
  /** close() has begun or finished: the store is retiring, and nothing may start or destroy anything on its behalf. */
  get retiring() {
    return this.closing || this.closed;
  }

  emit(type, data) {
    const ev = { type, data };
    if (this.retiring) {
      // Applied nowhere: the store has been handed over. Said once, so an exit callback’s stream doesn’t flood the log.
      if (!this.warned) console.error(`An event after the store closed was dropped: ${this.cause?.message}`);
      this.warned = true;
      return ev;
    }
    if (this.waitingCommits || this.held) {
      this.held++;
      this.queue.push({ held: ev, json: JSON.stringify(ev) }); // as it is now: the caller may change its object later
      this.pump();
      return ev;
    }
    this.sequence(ev);
    const line = this.record(ev);
    this.notify(ev);
    if (!this.writable) {
      if (!this.warned) console.error(`An event wasn’t written: ${this.cause?.message}`);
      this.warned = true;
    } else if (this.dir) {
      this.queue.push({ line: `${line}\n` });
      this.sinceSnapshot++;
      this.pump();
    }
    return ev;
  }

  /**
   * Releases a held emit: numbered now, applied from the JSON made when it was called, and broadcast; the seq goes on
   * the object emit() returned. Gives the line to write.
   * @param {{ held: any, json: string }} job
   */
  release({ held, json }) {
    const ev = this.sequence(JSON.parse(json));
    held.seq = ev.seq;
    const line = this.record(ev);
    this.notify(ev);
    if (this.dir) this.sinceSnapshot++;
    this.held--;
    return line;
  }

  /**
   * Commits several events as one line, all durable or none (server/store-commit.mjs). With an opId, a repeat
   * resolves `{ seq, duplicate: true }` without writing. Rejects with the cause while writes are closed.
   * @param {any[] | ((state: any) => any[])} events @param {{ opId?: string }} [options]
   */
  commit(events, options) {
    return commit(this, events, options);
  }

  /** Starts the writer’s loop if it isn’t running, writes are open and no reload is under way. */
  pump() {
    if (this.running || !this.writable || !this.queue.length) return;
    const gen = this.generation;
    this.running = run(this, gen).finally(() => {
      if (this.generation !== gen) return; // a reload took the loop over
      this.running = null;
      this.pump();
    });
  }

  /** A job for the writer’s loop, resolved when it has run; rejected with the cause while writes are closed. @param {'flush' | 'snapshot'} kind */
  job(kind) {
    if (!this.writable || this.closed || (kind === 'snapshot' && this.closing)) return Promise.reject(this.cause);
    return new Promise((resolve, reject) => {
      this.queue.push({ [kind]: { resolve, reject } });
      this.pump();
    });
  }

  /** Waits for every queued event to reach the disk. */
  async flush() {
    await this.job('flush');
  }

  /** Writes a snapshot, starts a new log segment, and deletes the segments the snapshot covers. */
  async snapshot() {
    if (this.dir) await this.job('snapshot');
  }

  /**
   * Flushes, lets go of the log, releases the folder for the next store, and closes this store for good: a late emit or
   * commit (an adapter’s exit callback after shutdown) is refused and never reopens the segment, since another store may
   * hold the folder by then and two must never interleave lines in one log (the integrator’s review of 1a).
   */
  async close() {
    // The boundary, before any await: from here no commit or emit is taken and no snapshot renames or prunes, so no
    // work started during the close outlives the lock (the integrator’s review of 1a: a snapshot the writer began
    // after close()’s flush landed after the release and deleted the next store’s segment).
    this.closing = true;
    const closed = Object.assign(new Error('The store is closed: Postbox shut it down, so nothing more is saved here.'), { code: 'ECLOSED' });
    this.cause ??= closed;
    try {
      if (this.writable) await this.flush(); // the last sync of what was acknowledged
    } finally {
      await this.running?.catch(() => {}); // the writer’s pass under way ends (a snapshot it began abandons itself)
      this.closed = true;
      this.writable = false;
      this.cause = closed;
      try {
        await this.fh?.close();
      } catch (e) {
        console.error(`The event log’s descriptor didn’t close cleanly: ${e.message}`); // the lock is released either way
      } finally {
        this.fh = null;
        await unlockStore(this.io, this.lock);
        this.lock = null;
      }
    }
  }

  /** Events after `seq`, or null when they’re no longer kept and the client must refetch the state. */
  since(seq) {
    if (seq >= this.state.seq) return [];
    const first = this.events[0]?.seq ?? this.state.seq + 1;
    if (seq + 1 < first) return null;
    return this.events.filter((e) => e.seq > seq).map((e) => JSON.parse(e.line));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async size() {
    if (!this.dir) return 0;
    let total = 0;
    for (const n of await this.io.readdir(this.dir)) if (n === 'snapshot.json' || /^events-/.test(n)) total += (await this.io.stat(this.at(n))).size;
    return total;
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
