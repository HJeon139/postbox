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
// reads whatever landed (server/store-reload.mjs, the one recovery path). Retry as a reload is 1b’s; the generation
// check is its seam: a loop whose generation is no longer the store’s finishes its step and publishes nothing.

/** The segment the log is being appended to, opened once. @param {import('./store.mjs').Store} store */
async function handle(store) {
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
 */
async function append(store, text, gen, sync) {
  const fh = await handle(store);
  if (store.generation !== gen) throw fenced();
  await writeAll(fh, Buffer.from(text), `The event log ${store.segment}`);
  if (store.generation !== gen) throw fenced();
  if (!sync) return;
  await fh.sync();
  if (store.generation !== gen) throw fenced();
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
    if (c.opId !== undefined) store.ops.set(c.opId, c.events[0].seq);
    store.sinceSnapshot += c.events.length;
  }
  for (const ev of heard) store.notify(ev);
  for (const c of commits) c.resolve({ seq: c.events[0].seq, duplicate: false });
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
  for (const c of group) {
    const events = sequenced(store, c);
    if (!events) continue;
    c.events = events;
    written.push(c);
  }
  try {
    if (written.length && store.dir) await append(store, written.map((c) => lineOf(c.events)).join(''), gen, true);
    applyCommits(store, written);
  } catch (e) {
    if (e.code !== 'ERELOADED') fail(store, e); // the written commits get the same cause as every later one
    for (const c of written) c.reject(store.writable ? e : store.cause);
  } finally {
    store.waitingCommits -= group.length;
  }
}

/** Writes the lines at the head of the queue, releasing held emits (numbered and applied now) in their order. */
async function writeLines(store, gen) {
  const lines = [];
  while (store.queue[0]?.line !== undefined || store.queue[0]?.held) {
    const job = store.queue.shift();
    if (job.held) {
      const line = store.release(job);
      if (store.dir) lines.push(`${line}\n`);
    } else lines.push(job.line);
  }
  if (!lines.length) return;
  try {
    await append(store, lines.join(''), gen, false);
  } catch (e) {
    if (e.code !== 'ERELOADED') fail(store, e);
  }
}

/**
 * Closes the store to commits on a write that failed (#508’s storage design, “When a write fails”, Q9): every queued
 * commit, flush and snapshot is rejected with the cause, held emits are released onto memory (applied and broadcast,
 * not written), and the loop ends. Nothing is written again; restarting Postbox is the recovery.
 * @param {import('./store.mjs').Store} store @param {Error & { code?: string }} e
 */
function fail(store, e) {
  const cause = Object.assign(
    new Error(`Postbox can’t write its event log (${e.code ?? 'error'}): ${e.message}. Reads go on; commits are refused until Postbox restarts.`),
    {
      code: e.code,
      cause: e,
    },
  );
  console.error(cause.message);
  store.writable = false;
  store.cause = cause;
  const queue = store.queue;
  store.queue = [];
  for (const job of queue) {
    if (job.held)
      store.release(job); // applied and broadcast on the memory the page reads, not written, like every emit from now on
    else if (job.commit) store.waitingCommits--;
    (job.commit ?? job.flush ?? job.snapshot)?.reject(cause);
  }
}

/**
 * The writer’s loop: one job, or one group of like jobs, at a time, in queue order, until the queue is empty, the store
 * closes, or its generation moves on.
 * @param {import('./store.mjs').Store} store @param {number} gen  the generation this loop runs as
 */
export async function run(store, gen) {
  while (store.queue.length && store.generation === gen && store.writable) {
    const job = store.queue[0];
    if (job.commit) await writeCommits(store, gen);
    else if (job.line !== undefined || job.held) await writeLines(store, gen);
    else if (job.flush) {
      store.queue.shift();
      await (store.fh ? store.fh.sync() : Promise.resolve()).then(job.flush.resolve, job.flush.reject);
    } else if (job.snapshot) {
      store.queue.shift();
      await takeSnapshot(store).then(job.snapshot.resolve, job.snapshot.reject);
    }
    if (store.dir && store.writable && store.generation === gen && store.sinceSnapshot >= store.snapshotEvery)
      await takeSnapshot(store).catch((e) => console.error(`Couldn’t write a snapshot: ${e.message}`));
  }
}

/**
 * Commits events as one durable line (see the header). `events` is an array of `{type, data}`, or a function of the
 * state that gives one, evaluated when the commit is sequenced. Resolves `{ seq, duplicate }` once the line is fsynced;
 * rejects with the cause while the store is closed.
 * @param {import('./store.mjs').Store} store @param {any[] | ((state: any) => any[])} events @param {{ opId?: string }} [opts]
 * @returns {Promise<{ seq: number, duplicate: boolean }>}
 */
export function commit(store, events, { opId } = {}) {
  if (!store.writable) return Promise.reject(store.cause);
  return new Promise((resolve, reject) => {
    store.queue.push({ commit: { events, opId, resolve, reject } });
    store.waitingCommits++;
    store.pump();
  });
}

const PIECE = 1 << 20; // the snapshot’s text goes to the disk in pieces this long

/**
 * Writes the state to snapshot.json atomically: a temporary file, written in 1 MB pieces (one write of the whole text
 * converts it to bytes in one go, which blocked the loop for about half the snapshot’s time, #508’s storage design,
 * “Snapshots and pruning”), fsynced, then renamed over the snapshot. The caller syncs the folder.
 * @param {{ io: typeof import('node:fs/promises'), at: (name: string) => string, state: any }} store
 */
export async function writeSnapshot(store) {
  const path = store.at('snapshot.json');
  const tmp = `${path}.${process.pid}.tmp`;
  const text = JSON.stringify(store.state);
  const fh = await store.io.open(tmp, 'w');
  try {
    for (let at = 0; at < text.length; at += PIECE) await writeAll(fh, Buffer.from(text.slice(at, at + PIECE)), `The snapshot ${tmp}`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await store.io.rename(tmp, path);
}

/** Makes a rename, or a new segment’s directory entry, durable. @param {{ io: typeof import('node:fs/promises'), dir: string | null }} store */
export async function syncDir(store) {
  const dh = await store.io.open(/** @type {string} */ (store.dir), 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

/**
 * Writes a snapshot, starts a new log segment, and deletes the segments the snapshot covers, once the folder is synced:
 * if that fails, nothing is deleted. Runs in the writer’s loop, so never while a commit is pending, and every event in
 * the covered segments is at or below the snapshot’s seq.
 */
async function takeSnapshot(store) {
  await writeSnapshot(store);
  await syncDir(store);
  await store.fh?.close();
  store.fh = null;
  const covered = await store.segments();
  store.segment = `events-${store.state.seq + 1}.jsonl`;
  store.freshSegment = true;
  store.sinceSnapshot = 0;
  store.ops.clear(); // opIds are remembered for the commits newer than the latest snapshot
  for (const seg of covered) if (seg.name !== store.segment) await store.io.rm(store.at(seg.name), { force: true });
}
