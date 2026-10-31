// Postbox’s store: an append-only event log (JSON Lines) plus periodic snapshots, with all reads served
// from an in-memory projection. See designs/architecture.md, “The store”, and #508’s design, “Storage”.
//
// Every change goes through emit(), one event applied, numbered, appended and told at once, or commit(), several
// events written as ONE fsynced line and applied only once the disk has them (server/store-commit.mjs). Both number
// their events through sequence(), the one place a seq is assigned. A browser that reconnects asks for everything
// after the last number it saw, so nothing is lost or duplicated.
//
//   <dir>/snapshot.json          the state as of some sequence number (written atomically)
//   <dir>/events-<from>.jsonl    events after that, one per line, or one commit’s array per line; a new segment
//                                starts at each snapshot
//   <dir>/store.lock             the pid of the process whose store holds the folder (server/store-lock.mjs)
//
// Every file access goes through this.io (node:fs/promises unless a test gives one), so a test can fail one operation.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { apply, emptyState, ownState } from '../shared/state.mjs';
import { commit, replay, run, writeSnapshot } from './store-commit.mjs';
import { lockStore, unlockStore } from './store-lock.mjs';

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
    // The history the seqs count within: a token new at each load(), so a page from before a restart, whose seq may
    // name events this store never kept, is told to resync whatever its seq (server/live-streams.mjs).
    this.epoch = newId('ep');
    this.listeners = new Set();
    // The writer’s jobs (server/store-commit.mjs), in order: a line to append, a held emit, a commit, a flush or a
    // snapshot; and its loop, while one runs.
    this.queue = [];
    this.running = null;
    this.segment = 'events-1.jsonl'; // the current log file; load() picks the real one
    this.fh = null; // the segment, open for appending
    this.offset = 0; // where the segment ends, so a failed write can be read back
    this.uncertain = null; // a write whose outcome the writer has still to read back
    this.sinceSnapshot = 0;
    this.ops = new Map(); // opId → the seq of its commit’s first event, for the commits since the latest snapshot
    this.ahead = 0; // events numbered but not yet applied: a commit’s, before its fsync
    this.waitingCommits = 0; // commits queued or pending; emits are held behind them
    this.held = 0; // emits held in the queue, still to be numbered
    this.lock = null; // the lock file’s path while this store holds the folder
  }

  /** Takes the folder (one store per folder, or load() rejects naming the holder), reads it, and leaves the writer at its end. */
  async load() {
    this.epoch = newId('ep');
    if (!this.dir) return this;
    await this.io.mkdir(this.dir, { recursive: true });
    this.lock = await lockStore(this.io, this.dir);
    try {
      await this.readSnapshot();
      await replay(this);
      this.segment = (await this.segments()).at(-1)?.name ?? `events-${this.state.seq + 1}.jsonl`;
    } catch (e) {
      await unlockStore(this.io, this.lock);
      this.lock = null;
      throw e;
    }
    return this;
  }

  /** Reads the snapshot, or once, Stage 2’s store.json as the first snapshot. */
  async readSnapshot() {
    const snapPath = this.at('snapshot.json');
    try {
      this.state = ownState({ ...emptyState(), ...JSON.parse(await this.io.readFile(snapPath, 'utf8')) });
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Couldn’t read the snapshot at ${snapPath}: ${e.message}`);
      const legacy = this.at('store.json');
      try {
        this.state = ownState({ ...emptyState(), ...JSON.parse(await this.io.readFile(legacy, 'utf8')) });
        await writeSnapshot(this);
        await this.io.rename(legacy, `${legacy}.migrated`);
      } catch (le) {
        if (le.code !== 'ENOENT') throw new Error(`Couldn’t read the old store at ${legacy}: ${le.message}`);
      }
    }
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
   * Applies a change and broadcasts it, unless a commit is pending: then it’s held, and numbered, applied and
   * broadcast in its turn once the commit resolves or fails (the returned event gets its seq then).
   */
  emit(type, data) {
    const ev = { type, data };
    if (this.waitingCommits || this.uncertain || this.held) {
      this.held++;
      this.queue.push({ held: ev });
      this.pump();
      return ev;
    }
    this.sequence(ev);
    const line = this.record(ev);
    this.notify(ev);
    if (this.dir) {
      this.queue.push({ line: `${line}\n` });
      this.sinceSnapshot++;
      this.pump();
    }
    return ev;
  }

  /**
   * Commits several events as one line, all durable or none (server/store-commit.mjs). With an opId, a repeat
   * resolves `{ seq, duplicate: true }` without writing.
   * @param {any[] | ((state: any) => any[])} events @param {{ opId?: string }} [options]
   */
  commit(events, options) {
    return commit(this, events, options);
  }

  /** Starts the writer’s loop if it isn’t running. After a failure it waits for the next emit, commit or flush. */
  pump() {
    if (this.running || !this.queue.length) return;
    this.running = run(this).finally(() => {
      this.running = null;
      if (this.queue.length && !this.uncertain) this.pump();
    });
  }

  /** A job for the writer’s loop, resolved when it has run. @param {'flush' | 'snapshot'} kind */
  job(kind) {
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

  /** Flushes, lets go of the log, and releases the folder for the next store. */
  async close() {
    try {
      await this.flush();
    } finally {
      await this.fh?.close();
      this.fh = null;
      await unlockStore(this.io, this.lock);
      this.lock = null;
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
