// Postbox’s store: an append-only event log (JSON Lines) plus periodic snapshots, with all reads served
// from an in-memory projection. See designs/architecture.md, “The store”.
//
// Every change goes through emit(), which applies it with the shared reducer, numbers it, appends it to
// the log and tells subscribers. A browser that reconnects asks for everything after the last number it
// saw, so nothing is lost or duplicated.
//
//   <dir>/snapshot.json          the state as of some sequence number (written atomically)
//   <dir>/events-<from>.jsonl    events after that, one per line; a new segment starts at each snapshot

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, emptyState, ownState } from '../shared/state.mjs';

export { emptyState };

const KEEP_EVENTS = 20000; // events kept in memory for reconnecting browsers
const SNAPSHOT_EVERY = 5000; // events between snapshots

export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8) || Date.now().toString(36)}`;

export class Store {
  /** @param {string|null} dir  the data folder; null keeps everything in memory (tests) */
  constructor(dir, { snapshotEvery = SNAPSHOT_EVERY } = {}) {
    this.dir = dir;
    this.snapshotEvery = snapshotEvery;
    this.state = emptyState();
    this.events = [];
    this.listeners = new Set();
    this.queue = []; // lines waiting to be appended
    this.writing = null; // the append in progress
    this.segment = 'events-1.jsonl'; // the current log file; load() picks the real one
    this.sinceSnapshot = 0;
  }

  async load() {
    if (!this.dir) return this;
    await mkdir(this.dir, { recursive: true });
    const snapPath = join(this.dir, 'snapshot.json');
    try {
      this.state = ownState({ ...emptyState(), ...JSON.parse(await readFile(snapPath, 'utf8')) });
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Couldn’t read the snapshot at ${snapPath}: ${e.message}`);
      // Stage 2 kept everything in one store.json; read it once as the first snapshot.
      const legacy = join(this.dir, 'store.json');
      try {
        this.state = ownState({ ...emptyState(), ...JSON.parse(await readFile(legacy, 'utf8')) });
        await this.writeSnapshot();
        await rename(legacy, `${legacy}.migrated`);
      } catch (le) {
        if (le.code !== 'ENOENT') throw new Error(`Couldn’t read the old store at ${legacy}: ${le.message}`);
      }
    }
    // Replay the log after the snapshot. A torn last line (a crash mid-write) is dropped.
    for (const seg of await this.segments()) {
      const path = join(this.dir, seg.name);
      const text = await readFile(path, 'utf8');
      let offset = 0;
      for (const line of text.split('\n')) {
        const end = offset + Buffer.byteLength(line) + 1;
        if (line.trim()) {
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            await truncate(path, offset);
            console.warn(`Dropped an incomplete event at the end of ${seg.name} (the server stopped mid-write).`);
            break;
          }
          if (ev.seq > this.state.seq) {
            apply(this.state, ev.type, ev.data);
            this.state.seq = ev.seq;
            this.sinceSnapshot++;
          }
        }
        offset = end;
      }
    }
    this.segment = (await this.segments()).at(-1)?.name ?? `events-${this.state.seq + 1}.jsonl`;
    return this;
  }

  /** A path in the data folder. Only the disk-backed paths call this, after checking there is one. */
  at(name) {
    return join(/** @type {string} */ (this.dir), name);
  }

  async segments() {
    if (!this.dir) return [];
    return (await readdir(this.dir))
      .filter((n) => /^events-\d+\.jsonl$/.test(n))
      .map((name) => ({ name, from: Number(name.slice(7, -6)) }))
      .sort((a, b) => a.from - b.from);
  }

  /** Applies a change and broadcasts it. The shared reducer is the only place state changes. */
  emit(type, data) {
    const ev = { seq: this.state.seq + 1, type, data };
    // The reducer keeps an event’s objects in the state, where later events change them in place, so the backlog
    // keeps each event as JSON: a reconnecting browser gets it as it was emitted, not as the state is now.
    const line = JSON.stringify(ev);
    apply(this.state, type, data);
    this.state.seq = ev.seq;
    this.events.push({ seq: ev.seq, line });
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
    for (const fn of this.listeners) fn(ev);
    if (this.dir) {
      this.queue.push(line + '\n');
      this.sinceSnapshot++;
      this.pump();
    }
    return ev;
  }

  /** Appends queued lines in order, one write at a time. */
  pump() {
    if (this.writing || !this.queue.length) return;
    const chunk = this.queue.splice(0).join('');
    const file = this.at(this.segment);
    this.writing = appendFile(file, chunk)
      .catch((e) => console.error(`Couldn’t append to the event log: ${e.message}`))
      .then(async () => {
        if (this.sinceSnapshot >= this.snapshotEvery) await this.snapshot();
        this.writing = null;
        this.pump();
      });
  }

  /** Writes a snapshot, starts a new log segment, and deletes segments the snapshot covers. */
  async snapshot() {
    await this.writeSnapshot();
    const old = await this.segments();
    this.segment = `events-${this.state.seq + 1}.jsonl`;
    this.sinceSnapshot = 0;
    for (const seg of old) if (seg.name !== this.segment) await rm(this.at(seg.name), { force: true });
  }

  async writeSnapshot() {
    const path = this.at('snapshot.json');
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state));
    const fh = await open(tmp, 'r+');
    await fh.sync();
    await fh.close();
    await rename(tmp, path);
  }

  /** Waits for every queued event to reach the disk. */
  async flush() {
    if (!this.dir) return;
    while (this.writing || this.queue.length) {
      this.pump();
      await this.writing;
    }
    try {
      const fh = await open(this.at(this.segment), 'r+');
      await fh.sync();
      await fh.close();
    } catch {
      /* nothing written yet */
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
    for (const n of await readdir(this.dir)) if (n === 'snapshot.json' || /^events-/.test(n)) total += (await stat(join(this.dir, n))).size;
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
