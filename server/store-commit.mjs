// The store’s writer (server/store.mjs; #508’s storage design, “The writer” and “commit”): one loop that appends every
// line to the current log segment, in the order the events were numbered, and takes the snapshots.
//
// A commit is several events written as ONE line (shared/log-lines.mjs): a plain event line when it holds one event, a
// JSON array of `{seq,type,data}` with consecutive seqs when it holds several; its opId rides as `op` on the first
// event. The bytes are written whole, then fsynced, and only then is the batch applied to the state, kept for since()
// and broadcast: before the fsync, nothing of it shows anywhere. Emits made while a commit is queued or in flight are
// held (not numbered, not applied, not broadcast) and released, in order, once it resolves or fails, from the JSON made
// when they were called, so memory, log and stream keep one order. Commits queued together share one fsync. A plain
// emit’s line is written without an fsync, as before. A segment’s first commit also fsyncs the folder, so a file made a
// moment ago can’t vanish with an acknowledged commit in it.
//
// When a write or an fsync fails, the line may be on disk, whole or torn, and nothing here settles that: every queued
// commit is rejected with the cause and the store closes to commits until Postbox restarts (#508’s Q9), when load()
// reads whatever landed (server/store-recover.mjs, the one recovery path). Retry as a reload is 1b’s; the generation
// check is its seam: a loop whose generation is no longer the store’s finishes its step and publishes nothing.

import { snapshotNow, syncDir } from './store-snapshot.mjs';

/** The segment the log is being appended to, opened once. @param {import('./store.mjs').Store} store */
async function handle(store) {
  if (store.closed) throw store.cause; // never reopened after close(): another store may hold the folder now
  store.fh ??= await store.io.open(store.at(store.segment), 'a');
  return store.fh;
}

/** The error a fenced writer fails its step with: the commit may be on disk, and the next load decides. */
const fenced = () =>
  Object.assign(new Error('The store was reset while this write was in flight; its outcome is whatever the next load reads back.'), { code: 'ERELOADED' });

/**
 * Writes a buffer whole through a handle: a write may take fewer bytes than given.
 * @param {import('node:fs/promises').FileHandle} fh @param {Buffer} buf @param {string} name  what’s being written, for the error
 */
export async function writeAll(fh, buf, name) {
  for (let off = 0; off < buf.length; ) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    if (!(bytesWritten > 0)) throw new Error(`${name} took none of the ${buf.length - off} bytes left to write.`);
    off += bytesWritten;
  }
}

/**
 * Appends text at the end of the segment, fsyncing it (and, the first time a commit lands in a fresh segment, the folder)
 * when `sync` says. Throws `fenced()` after any step a reload overtook, so a late completion publishes nothing.
 * @param {import('./store.mjs').Store} store @param {string} text @param {number} gen @param {boolean} sync
 * @param {number} through  the last seq the text carries, for savedThrough
 */
async function append(store, text, gen, sync, through) {
  const fh = await handle(store);
  if (store.generation !== gen) throw fenced();
  await writeAll(fh, Buffer.from(text), `The event log ${store.segment}`);
  if (store.generation !== gen) throw fenced();
  if (through > store.writtenThrough) store.writtenThrough = through;
  if (!sync) return;
  await fh.sync();
  if (store.generation !== gen) throw fenced();
  store.savedThrough = store.writtenThrough;
  if (store.freshSegment) {
    await syncDir(store);
    if (store.generation !== gen) throw fenced();
    store.freshSegment = false;
  }
}

/** Applies committed batches in order, all of them before any listener hears, then tells the listeners and resolves. */
function applyCommits(store, commits) {
  const heard = [];
  for (const c of commits) {
    for (const ev of c.events) {
      store.record(ev);
      heard.push(ev);
    }
    if (c.opId !== undefined) store.ops.set(c.opId, c.events.at(-1).seq); // the last seq, as the design says
    store.sinceSnapshot += c.events.length;
  }
  for (const ev of heard) store.notify(ev);
  for (const c of commits) {
    c.resolve({ seq: c.events.at(-1).seq, duplicate: false });
    for (const f of c.followers ?? []) f.resolve({ seq: c.events.at(-1).seq, duplicate: true });
  }
}

/** A commit’s events as its log line (the header): the event itself for one, the array for several. */
const lineOf = (events) => `${JSON.stringify(events.length === 1 ? events[0] : events)}\n`;

/**
 * Numbers a commit’s events, or settles it without a write: a repeat of a known opId resolves `duplicate`, a function
 * that fails or gives no array rejects, no events resolve at once. Returns the events to write, or null.
 * @param {import('./store.mjs').Store} store
 */
function sequenced(store, c) {
  if (c.opId !== undefined && store.ops.has(c.opId)) {
    c.resolve({ seq: store.ops.get(c.opId), duplicate: true });
    return null;
  }
  let given;
  try {
    given = typeof c.events === 'function' ? c.events(store.state) : c.events;
    if (!Array.isArray(given)) throw new TypeError('A commit takes an array of events, or a function of the state that returns one.');
  } catch (e) {
    c.reject(e); // the caller’s events are no good: its commit fails, and nothing was numbered
    return null;
  }
  const events = given.map((e) => store.sequence({ type: e.type, data: e.data }));
  if (!events.length) {
    c.resolve({ seq: store.state.seq + store.ahead, duplicate: false });
    return null;
  }
  if (c.opId !== undefined) events[0].op = c.opId;
  return events;
}

/**
 * Takes the commits at the head of the queue (a function commit only first, so it sees every earlier batch applied),
 * numbers their events, writes one line each, one fsync for all, then applies and resolves them. A failure rejects
 * them and closes the store (fail), unless a reload already overtook this loop.
 * @param {import('./store.mjs').Store} store @param {number} gen
 */
async function writeCommits(store, gen) {
  const group = [];
  while (store.queue[0]?.commit && !(typeof store.queue[0].commit.events === 'function' && group.length)) group.push(store.queue.shift().commit);
  const written = [];
  const pending = new Map(); // opId → the commit of this group that writes it
  for (const c of group) {
    const first = c.opId !== undefined ? pending.get(c.opId) : undefined;
    if (first) {
      (first.followers ??= []).push(c); // a repeat queued behind its original gets the original’s result, either way
      continue;
    }
    const events = sequenced(store, c);
    if (!events) continue;
    c.events = events;
    written.push(c);
    if (c.opId !== undefined) pending.set(c.opId, c);
  }
  try {
    if (written.length && store.dir) await append(store, written.map((c) => lineOf(c.events)).join(''), gen, true, written.at(-1).events.at(-1).seq);
    applyCommits(store, written);
  } catch (e) {
    // The numbers these commits took are given back first, so the held emits fail() releases, and every emit after,
    // go on from the applied seq with no gap (critic’s finding on 1a).
    for (const c of written) store.ahead -= c.events.length; // exact while only append() can throw here: applyCommits doesn’t
    if (e.code !== 'ERELOADED') fail(store, e); // the written commits get the same cause as every later one
    for (const c of written) for (const r of [c, ...(c.followers ?? [])]) r.reject(store.writable ? e : store.cause);
  } finally {
    store.waitingCommits -= group.length;
  }
}

/** Writes the lines at the head of the queue, releasing held emits (numbered and applied now) in their order. */
async function writeLines(store, gen) {
  const lines = [];
  let through = 0;
  while (store.queue[0]?.line !== undefined || store.queue[0]?.held) {
    const job = store.queue.shift();
    if (job.held) {
      const line = store.release(job);
      through = job.held.seq;
      if (store.dir) lines.push(`${line}\n`);
    } else {
      lines.push(job.line);
      through = job.seq;
    }
  }
  if (!lines.length) return;
  try {
    await append(store, lines.join(''), gen, false, through);
  } catch (e) {
    if (e.code !== 'ERELOADED') fail(store, e);
  }
}

/** A write that failed closes the store (server/store-retry.mjs). */
function fail(store, e) {
  store.fail(e);
}

/**
 * The writer’s loop: one job, or one group of like jobs, at a time, in queue order, until the queue is empty, the store
 * closes, or its generation moves on.
 * @param {import('./store.mjs').Store} store @param {number} gen  the generation this loop runs as
 */
export async function run(store, gen) {
  while (store.queue.length && store.generation === gen && (store.writable || store.reconciling)) {
    const job = store.queue[0];
    if (job.commit) await writeCommits(store, gen);
    else if (job.line !== undefined || job.held) await writeLines(store, gen);
    else if (job.flush) {
      store.queue.shift();
      await (store.fh ? store.fh.sync() : Promise.resolve()).then(
        () => {
          store.savedThrough = store.writtenThrough;
          job.flush.resolve();
        },
        (e) => {
          fail(store, e); // a flush that can’t sync the log is the first failed fsync: the store closes to commits (Q9)
          job.flush.reject(store.cause);
        },
      );
    } else if (job.snapshot) {
      store.queue.shift();
      await snapshotNow(store).then(job.snapshot.resolve, job.snapshot.reject);
    }
    // No snapshot begins once close() has: its rename and pruning would outlive the lock (the integrator’s review of 1a).
    if (
      store.dir &&
      store.writable &&
      !store.retiring &&
      store.generation === gen &&
      store.sinceSnapshot >= store.snapshotEvery &&
      Date.now() >= store.nextSnapshotAt
    )
      await snapshotNow(store).catch(() => {}); // recorded as a warning with a next-attempt time, never a close
  }
}

/**
 * Commits events as one durable line (see the header). `events` is an array of `{type, data}`, or a function of the
 * state that gives one, evaluated when the commit is sequenced. Resolves `{ seq, duplicate }` once the line is fsynced;
 * rejects with the cause while the store is closed.
 * @param {import('./store.mjs').Store} store @param {any[] | ((state: any) => any[])} events @param {{ opId?: string, internal?: boolean }} [opts]
 * @returns {Promise<{ seq: number, duplicate: boolean }>}
 */
export function commit(store, events, { opId, internal = false } = {}) {
  // Closed to every caller but the reconciliation Retry runs itself (store.reconcile), which carries `internal`; the
  // outside entry points (the router, the tools, a turn start) never set it, and are gated on `writable` before here.
  if (store.retiring || (!store.writable && !(internal && store.reconciling))) return Promise.reject(store.cause);
  return new Promise((resolve, reject) => {
    store.queue.push({ commit: { events, opId, resolve, reject } });
    store.waitingCommits++;
    store.pump();
  });
}
