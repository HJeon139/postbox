// The store’s writer (server/store.mjs; #508’s design, “Storage”, PR 1a “one-line commit”): one loop that appends
// every line to the current log segment, in the order the events were numbered, and takes the snapshots.
//
// A commit is several events written as ONE line: a JSON array of `{seq,type,data}` with consecutive seqs, its opId as
// `op` on the first event. Its bytes are written whole, then fsynced, and only then is the batch applied to the state,
// kept for since() and broadcast: before the fsync, nothing of it shows anywhere. Emits made while a commit is queued
// or pending are held (not numbered, not applied, not broadcast) and released, in order, once it resolves or fails, so
// memory, log and stream keep one order. Commits queued together share one fsync. A plain emit’s line is written
// without an fsync, as before.
//
// When a write or an fsync fails, the outcome is uncertain: the line may be on disk, whole or torn. The loop settles
// that before it writes anything else, by reading the segment back from where the line began: a whole line is fsynced
// again and applied, as a restart would apply it (its opId is then remembered, so a retry of the commit finds it a
// duplicate); a torn one is cut off and its seqs given back.
//
// Replay (load) reads legacy single-event lines and array lines alike. A line without its newline never finished: the
// writer puts a line and its newline in one write, so it was never acknowledged. At the end of the LAST segment that’s
// a crash mid-write, and it’s dropped; a bad line anywhere else is damage, and load() refuses, naming the file and the
// line, rather than dropping what follows.

import { apply } from '../shared/state.mjs';

/** The segment the log is being appended to, opened once. @param {import('./store.mjs').Store} store */
async function handle(store) {
  store.fh ??= await store.io.open(store.at(store.segment), 'a');
  return store.fh;
}

/** Writes a buffer whole: a write may take fewer bytes than given. @param {import('./store.mjs').Store} store @param {Buffer} buf */
async function writeAll(store, buf) {
  const fh = await handle(store);
  for (let off = 0; off < buf.length; ) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    if (!(bytesWritten > 0)) throw new Error(`The event log ${store.segment} took none of the ${buf.length - off} bytes left to write.`);
    off += bytesWritten;
  }
}

/**
 * Appends bytes at the end of the segment. On failure the outcome is uncertain, and the loop settles it before its next
 * write: `carried` says which commits the bytes carry, and how many numbered, unapplied events to give back if torn.
 * @param {import('./store.mjs').Store} store @param {string} text @param {{ commits: any[], events: number }} carried @param {boolean} sync
 */
async function append(store, text, carried, sync) {
  const buf = Buffer.from(text);
  const offset = store.offset;
  try {
    await writeAll(store, buf);
    if (sync) await store.fh.sync();
  } catch (e) {
    store.uncertain = { offset, bytes: buf, ...carried };
    throw e;
  }
  store.offset = offset + buf.length;
}

/** Applies committed batches in order, all of them before any listener hears, then tells the listeners and resolves. */
function applyCommits(store, commits) {
  const heard = [];
  for (const c of commits) {
    for (const ev of c.events) {
      store.record(ev);
      heard.push(ev);
    }
    if (c.opId !== undefined) store.ops.set(c.opId, c.events[0].seq);
    store.sinceSnapshot += c.events.length;
  }
  for (const ev of heard) store.notify(ev);
  for (const c of commits) c.resolve({ seq: c.events[0].seq, duplicate: false });
}

/**
 * Reads the segment back from where an uncertain line began. Whole: fsync it and apply it, as a restart would. Torn:
 * cut it off and give its seqs back. Anything else there is damage Postbox didn’t write, and the writer stops.
 * @param {import('./store.mjs').Store} store
 */
async function settle(store) {
  const { offset, bytes, commits, events } = store.uncertain;
  const path = store.at(store.segment);
  const tail = (await store.io.readFile(path)).subarray(offset);
  if (tail.equals(bytes)) {
    await (await handle(store)).sync();
    store.offset = offset + bytes.length;
    store.uncertain = null;
    applyCommits(store, commits);
  } else if (tail.length < bytes.length && bytes.subarray(0, tail.length).equals(tail)) {
    await store.io.truncate(path, offset);
    store.ahead -= events;
    store.uncertain = null;
    console.warn(`Dropped a torn line from ${store.segment}: its write failed, and ${events} event(s) of it never reached the disk.`);
  } else throw new Error(`The event log ${store.segment} holds bytes at ${offset} that Postbox didn’t write there. Not writing to it any further.`);
}

/**
 * Takes the commits at the head of the queue (a function commit only first, so it sees every earlier batch applied),
 * numbers their events, writes one line each, one fsync for all, then applies and resolves them.
 * @param {import('./store.mjs').Store} store
 */
async function writeCommits(store) {
  const group = [];
  while (store.queue[0]?.commit && !(typeof store.queue[0].commit.events === 'function' && group.length)) group.push(store.queue.shift().commit);
  const written = [];
  const lines = [];
  for (const c of group) {
    if (c.opId !== undefined && store.ops.has(c.opId)) {
      c.resolve({ seq: store.ops.get(c.opId), duplicate: true });
      continue;
    }
    let given;
    try {
      given = typeof c.events === 'function' ? c.events(store.state) : c.events;
      if (!Array.isArray(given)) throw new TypeError('A commit takes an array of events, or a function of the state that returns one.');
    } catch (e) {
      c.reject(e); // the caller’s events are no good: its commit fails, and nothing was numbered
      continue;
    }
    c.events = given.map((e) => store.sequence({ type: e.type, data: e.data }));
    if (!c.events.length) {
      c.resolve({ seq: store.state.seq + store.ahead, duplicate: false });
      continue;
    }
    if (c.opId !== undefined) c.events[0].op = c.opId;
    written.push(c);
    lines.push(`${JSON.stringify(c.events)}\n`);
  }
  try {
    if (written.length && store.dir) await append(store, lines.join(''), { commits: written, events: written.reduce((n, c) => n + c.events.length, 0) }, true);
    applyCommits(store, written);
  } catch (e) {
    for (const c of written) c.reject(e);
  } finally {
    store.waitingCommits -= group.length;
  }
}

/** Writes the lines at the head of the queue, releasing held emits (numbered and applied now) in their order. */
async function writeLines(store) {
  const lines = [];
  while (store.queue[0]?.line !== undefined || store.queue[0]?.held) {
    const job = store.queue.shift();
    if (job.held) {
      store.held--;
      store.sequence(job.held);
      const line = store.record(job.held);
      store.notify(job.held);
      if (store.dir) {
        lines.push(`${line}\n`);
        store.sinceSnapshot++;
      }
    } else lines.push(job.line);
  }
  if (lines.length)
    await append(store, lines.join(''), { commits: [], events: 0 }, false).catch((e) => console.error(`Couldn’t append to the event log: ${e.message}`));
}

/** Rejects the jobs waiting on a disk that can’t be settled; held emits stay queued for when it can. */
function fail(store, e) {
  console.error(`The event log can’t be written: ${e.message}`);
  store.queue = store.queue.filter((job) => {
    if (job.commit) store.waitingCommits--;
    (job.commit ?? job.flush ?? job.snapshot)?.reject(e);
    return job.held || job.line !== undefined;
  });
}

/** The writer’s loop: one job, or one group of like jobs, at a time, in queue order, until the queue is empty. */
export async function run(store) {
  while (store.queue.length) {
    if (store.uncertain) {
      try {
        await settle(store);
      } catch (e) {
        fail(store, e);
        return;
      }
    }
    const job = store.queue[0];
    if (job.commit) await writeCommits(store);
    else if (job.line !== undefined || job.held) await writeLines(store);
    else if (job.flush) {
      store.queue.shift();
      await (store.fh ? store.fh.sync() : Promise.resolve()).then(job.flush.resolve, job.flush.reject);
    } else if (job.snapshot) {
      store.queue.shift();
      await takeSnapshot(store).then(job.snapshot.resolve, job.snapshot.reject);
    }
    if (store.dir && !store.uncertain && store.sinceSnapshot >= store.snapshotEvery)
      await takeSnapshot(store).catch((e) => console.error(`Couldn’t write a snapshot: ${e.message}`));
  }
}

/**
 * Commits events as one durable line (see the header). `events` is an array of `{type, data}`, or a function of the
 * state that gives one, evaluated when the commit is sequenced. Resolves `{ seq, duplicate }` once the line is fsynced.
 * @param {import('./store.mjs').Store} store @param {any[] | ((state: any) => any[])} events @param {{ opId?: string }} [opts]
 * @returns {Promise<{ seq: number, duplicate: boolean }>}
 */
export function commit(store, events, { opId } = {}) {
  return new Promise((resolve, reject) => {
    store.queue.push({ commit: { events, opId, resolve, reject } });
    store.waitingCommits++;
    store.pump();
  });
}

/** Writes the state to snapshot.json atomically: a temporary file, fsynced, then renamed. */
export async function writeSnapshot(store) {
  const path = store.at('snapshot.json');
  const tmp = `${path}.${process.pid}.tmp`;
  await store.io.writeFile(tmp, JSON.stringify(store.state));
  const fh = await store.io.open(tmp, 'r+');
  await fh.sync();
  await fh.close();
  await store.io.rename(tmp, path);
}

/** Makes the snapshot’s rename durable before any segment it covers is deleted. */
async function syncDir(store) {
  const dh = await store.io.open(store.dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

/**
 * Writes a snapshot, starts a new log segment, and deletes the segments the snapshot covers, once the folder is synced:
 * if that fails, nothing is deleted. Runs in the writer’s loop, so never while a commit is pending.
 */
async function takeSnapshot(store) {
  await writeSnapshot(store);
  await syncDir(store);
  await store.fh?.close();
  store.fh = null;
  const covered = await store.segments();
  store.segment = `events-${store.state.seq + 1}.jsonl`;
  store.offset = 0;
  store.sinceSnapshot = 0;
  store.ops.clear(); // opIds are remembered for the commits newer than the latest snapshot
  for (const seg of covered) if (seg.name !== store.segment) await store.io.rm(store.at(seg.name), { force: true });
}

/** Applies one log line’s events (one, or a commit’s array), and remembers the commit’s opId. */
function applyLine(store, parsed) {
  const evs = Array.isArray(parsed) ? parsed : [parsed];
  const first = evs[0];
  const fresh = first?.seq > store.state.seq;
  for (const ev of evs)
    if (ev?.seq > store.state.seq) {
      apply(store.state, ev.type, ev.data);
      store.state.seq = ev.seq;
      store.sinceSnapshot++;
    }
  if (fresh && first.op !== undefined) store.ops.set(first.op, first.seq);
}

/** Replays the segments after the snapshot (the header says what a bad line means), leaving the writer at the end. */
export async function replay(store) {
  const segs = await store.segments();
  for (const [i, seg] of segs.entries()) {
    const path = store.at(seg.name);
    const text = await store.io.readFile(path, 'utf8');
    const lines = text.split('\n'); // the text after the final newline: empty when the file ends in one
    let offset = 0;
    store.offset = Buffer.byteLength(text);
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      const unfinished = n === lines.length - 1; // a last line without its newline
      if (line.trim()) {
        let parsed;
        let why = 'has no newline, so its write never finished';
        if (!unfinished)
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            why = `isn’t valid JSON (${e.message})`;
          }
        if (parsed === undefined) {
          if (unfinished && i === segs.length - 1) {
            await store.io.truncate(path, offset);
            store.offset = offset;
            console.warn(`Dropped an incomplete event at the end of ${seg.name} (the server stopped mid-write).`);
            break;
          }
          throw new Error(
            `Couldn’t load the event log: line ${n + 1} of ${seg.name} ${why}, and complete events follow it. Postbox won’t drop those; repair the line or move the file aside.`,
          );
        }
        applyLine(store, parsed);
      }
      offset += Buffer.byteLength(line) + 1;
    }
  }
}
