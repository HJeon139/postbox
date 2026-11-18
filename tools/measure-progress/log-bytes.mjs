// The event log’s bytes as the store writes them, by kind (designs/architecture/live-progress.md, “Why”). The store’s
// file access goes through an io a test may give (server/store.mjs), so countingIo hands it node:fs/promises with every
// write to a log segment kept, in order, including segments a snapshot later removes. tally reads those bytes back
// line by line: an event’s bytes are its own JSON’s, as JSON.stringify wrote them, and a commit’s array brackets,
// commas and every newline are framing, so the kinds and the framing add up to exactly what was written.

import fs from 'node:fs/promises';

/** A session patch’s fields that go live (live-progress.md, “What becomes live only”); `state` and `ctx` stay stored. */
const LIVE_FIELDS = new Set(['toolCalls', 'toolCount', 'currentStep', 'glimpse', 'subagents']);

/**
 * The kind an event is counted as. A session patch is progress when it sets only live fields, with or without the
 * `updatedAt` every patch may carry; mixed when it also sets a stored one, such as `state` beside `currentStep`, whose
 * stored part stays; and other when it sets none.
 * @param {{ type: string, data?: any }} ev
 */
export function kindOf(ev) {
  const d = ev.data ?? {};
  if (ev.type === 'item.text') return 'progress: item.text';
  if (ev.type === 'item.patch' && d.activityStep) return 'progress: item.patch activityStep';
  if (ev.type === 'item.patch' && d.foldSteps) return 'end: foldSteps';
  if (ev.type !== 'session.patch') return `other: ${ev.type}`;
  const keys = Object.keys(d.patch ?? {}).filter((k) => k !== 'updatedAt');
  const live = keys.filter((k) => LIVE_FIELDS.has(k)).length;
  if (!live) return 'other: session.patch';
  return live === keys.length && !(d.unset ?? []).length ? 'progress: session.patch' : 'mixed: session.patch';
}

/**
 * A file handle that keeps every byte written through it in `chunks`, in order.
 * @param {import('node:fs/promises').FileHandle} fh @param {Buffer[]} chunks
 */
export function countingHandle(fh, chunks) {
  return new Proxy(fh, {
    get(target, key) {
      if (key !== 'write') {
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return async (/** @type {Buffer} */ buf, /** @type {number} */ off = 0, /** @type {number} */ len = buf.length - off) => {
        const r = await target.write(buf, off, len);
        chunks.push(Buffer.from(buf.subarray(off, off + r.bytesWritten)));
        return r;
      };
    },
  });
}

/** node:fs/promises, keeping every byte written to a log segment, through countingHandle. */
export function countingIo() {
  /** @type {Buffer[]} */
  const chunks = [];
  const io = {
    ...fs,
    /** @param {string} path @param {any} flags @param {any} [mode] */
    async open(path, flags, mode) {
      const fh = await fs.open(path, flags, mode);
      return /events-[^/]*$/.test(path) ? countingHandle(fh, chunks) : fh;
    },
  };
  return { io, chunks, written: () => Buffer.concat(chunks) };
}

/**
 * The bytes by kind, the framing, and their total, which is the bytes given.
 * @param {Buffer} written @returns {{ kinds: Record<string, { bytes: number, events: number }>, framing: number, total: number }}
 */
export function tally(written) {
  /** @type {Record<string, { bytes: number, events: number }>} */
  const kinds = {};
  let framing = 0;
  for (const line of written.toString('utf8').split('\n')) {
    framing += 1; // its newline; the text after the last one is empty
    if (!line) continue;
    const parsed = JSON.parse(line);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    let inside = 0;
    for (const ev of events) {
      const bytes = Buffer.byteLength(JSON.stringify(ev));
      const row = (kinds[kindOf(ev)] ??= { bytes: 0, events: 0 });
      row.bytes += bytes;
      row.events++;
      inside += bytes;
    }
    framing += Buffer.byteLength(line) - inside;
  }
  framing -= 1; // the split’s last, empty piece has no newline of its own
  const total = framing + Object.values(kinds).reduce((a, r) => a + r.bytes, 0);
  return { kinds, framing, total };
}

/** The share of a tally in each bucket: progress, mixed and the rest. @param {ReturnType<typeof tally>} t */
export function shares(t) {
  const sum = (/** @type {string} */ prefix) => Object.entries(t.kinds).reduce((a, [k, r]) => (k.startsWith(prefix) ? a + r.bytes : a), 0);
  const events = (/** @type {string} */ prefix) => Object.entries(t.kinds).reduce((a, [k, r]) => (k.startsWith(prefix) ? a + r.events : a), 0);
  return { total: t.total, progress: sum('progress'), progressEvents: events('progress'), mixed: sum('mixed'), framing: t.framing };
}
