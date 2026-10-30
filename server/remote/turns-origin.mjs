// What a remote turn was asked, kept with it (#120, server/remote/turns.mjs, the header). A turn continued on its host
// (attached again after a restart or a lost link, resumed after Interrupted or Sign-in needed) is delivered as a
// notice, and ends as the turn it continues would have: with the same kind (a lint turn isn’t linted again, an app
// check settles its app), the same thread (a woken agent answers where it was woken, #377), a summary posted back
// that wakes no one, the same sender line, and the same request for Retry.
//
// The record is se.remoteTurn.origin, written when the turn starts (allocate) and kept through every update and
// restart: { kind, movesOn, from, summarizeTo, woke }, as the runtime’s deliver sets them on its
// turn, and the request Retry sends again, exactly, in one of three ways:
// - message: the request itself, when its JSON is within ORIGIN_MESSAGE_MAX, or null when there’s none to send again
//   (a turn attached again with no record, whose message only names the host turn);
// - messageRef: { sha256, size } of its JSON (UTF-8) in Postbox’s content-addressed store (rt.blobs), for a larger
//   one. It’s written before the record that names it is saved (prepare, then allocate): Postbox stopping in between
//   leaves an unnamed copy in the store and no turn on the host to continue. Retry reads it back (server/turn-marks.mjs);
// - message null and lost: true, for one that couldn’t be kept (no store, a failed write, or over ORIGIN_REF_MAX).
// Retry never sends another request in place of one kept that can’t be read back: it says so (askedAgain).
// Everything in it is read back from disk, so each part is checked before it’s used, and a record that can’t be read
// continues as an ordinary turn, as one from before it did.

import { hostOf } from './turns-shared.mjs';

/** The message kinds a turn is asked with (server/adapters/adapter.mjs). */
const KINDS = new Set(['user', 'agent', 'event', 'wake', 'lint', 'app-check', 'notice']);
/** The request kept inline in the record, as JSON, at most; a longer one is kept in Postbox’s store. */
export const ORIGIN_MESSAGE_MAX = 32_000;
/**
 * The request kept in the store, in bytes, at most: Postbox takes no request over 4 MB (server/index.mjs), and what
 * a turn is asked comes from one, so this covers the largest it accepts (a review’s 200 comments of up to 4,000
 * characters each, a 50,000-character message) with room to spare.
 */
export const ORIGIN_REF_MAX = 16 * 1024 * 1024;
/** As a persona’s handle is (Runtime.createPersona). */
const HANDLE = /^[a-z][a-z0-9_-]{1,23}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
/** A request that was kept but can’t be sent again exactly. */
const LOST = Object.freeze({ message: null, lost: true });

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An ID that names an entry of map, its own and not the prototype’s. @param {any} map @param {unknown} id */
const known = (map, id) => typeof id === 'string' && Boolean(map) && Object.hasOwn(map, id);
/** @param {unknown} v */
const json = (v) => {
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
};

/**
 * The record of a turn, for its se.remoteTurn, its request kept in Postbox’s store first when it’s too large to keep
 * inline: a continued turn’s is the one it continues. Never rejects: a request that can’t be kept is recorded as lost.
 * @param {any} rt @param {any} turn  the runtime’s turn @param {any} woke  what woke it (wokeOf)
 */
export async function keepOrigin(rt, turn, woke) {
  if (turn.origin) return turn.origin;
  return {
    kind: turn.kind,
    movesOn: turn.movesOn === true,
    from: turn.from ?? null,
    summarizeTo: turn.summarizeTo ?? null,
    woke: woke ?? null,
    ...(await kept(rt.blobs, turn.asked?.message)),
  };
}

/**
 * The request as Retry sends it again: a copy, inline, or kept in the store, or lost. A message that attaches to a
 * host turn asks nothing of the agent, so there’s nothing to keep.
 * @param {import('../blobs.mjs').Blobs | null} blobs @param {any} m
 */
async function kept(blobs, m) {
  if (!isObject(m) || typeof m.attach === 'string') return { message: null };
  const whole = json(m);
  if (whole === null) return LOST;
  if (whole.length <= ORIGIN_MESSAGE_MAX) return { message: JSON.parse(whole) };
  const bytes = Buffer.from(whole, 'utf8');
  if (!blobs || bytes.length > ORIGIN_REF_MAX) return LOST;
  try {
    const { sha256, size } = await blobs.put(bytes);
    return { messageRef: { sha256, size } };
  } catch {
    return LOST;
  }
}

/**
 * A record read back from disk, checked: null for one Postbox can’t use (missing, or of a kind it doesn’t know), else
 * each part that names a session, a thread or a handle that isn’t there, or isn’t one, is dropped.
 * @param {any} rt @param {unknown} raw
 */
export function readOrigin(rt, raw) {
  if (!isObject(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  const thread = (/** @type {unknown} */ id) => (known(rt.s.threads, id) ? /** @type {string} */ (id) : null);
  return {
    kind: o.kind,
    movesOn: o.movesOn === true,
    from: typeof o.from === 'string' && HANDLE.test(o.from) ? o.from.toLowerCase() : null,
    summarizeTo: thread(o.summarizeTo),
    woke: readWoke(rt, o.woke),
    ...readAsked(o.kind, o),
  };
}

/** What woke the turn, as wokeOf gives it. @param {any} rt @param {unknown} w */
function readWoke(rt, w) {
  if (!isObject(w)) return null;
  const v = /** @type {Record<string, unknown>} */ (w);
  if (v.scheduled === true) return { scheduled: true };
  if (typeof v.by !== 'string' || !HANDLE.test(v.by)) return null;
  return { by: v.by, ...(v.reply === true ? { reply: true, ...(known(rt.s.threads, v.in) ? { in: v.in } : {}) } : {}) };
}

/** The record’s request, checked: a ref or a message that isn’t one Retry can send is lost. @param {string} kind @param {Record<string, unknown>} o */
function readAsked(kind, o) {
  if (o.messageRef !== undefined) {
    const ref = readRef(o.messageRef);
    return ref ? { messageRef: ref } : LOST;
  }
  if (o.lost === true) return LOST;
  if (o.message === undefined || o.message === null) return { message: null };
  const message = readMessage(kind, o.message, ORIGIN_MESSAGE_MAX);
  return message ? { message } : LOST;
}

/**
 * A messageRef read back from disk, or null: a SHA-256 and a size in bytes within ORIGIN_REF_MAX.
 * @param {unknown} v @returns {{ sha256: string, size: number } | null}
 */
export function readRef(v) {
  if (!isObject(v)) return null;
  const { sha256, size } = /** @type {Record<string, unknown>} */ (v);
  if (typeof sha256 !== 'string' || !SHA256.test(sha256) || typeof size !== 'number') return null;
  return Number.isInteger(size) && size > 0 && size <= ORIGIN_REF_MAX ? { sha256, size } : null;
}

/**
 * The request a ref names, read back from the store, or null when it can’t be: no store, a copy missing or damaged
 * (get checks its hash), one of another size, or not a request of this kind Retry can send.
 * @param {import('../blobs.mjs').Blobs | null} blobs @param {{ sha256: string, size: number }} ref @param {unknown} kind
 */
export async function keptMessage(blobs, ref, kind) {
  if (!blobs || typeof kind !== 'string' || !KINDS.has(kind)) return null;
  try {
    const bytes = await blobs.get(ref.sha256);
    return bytes.length === ref.size ? readMessage(kind, JSON.parse(bytes.toString('utf8')), ORIGIN_REF_MAX) : null;
  } catch {
    return null;
  }
}

/**
 * The request, if it’s one Retry can send: of the record’s kind, within max as JSON, with the parts its kind needs.
 * @param {string} kind @param {unknown} m @param {number} max
 */
function readMessage(kind, m, max) {
  if (!isObject(m)) return null;
  const v = /** @type {Record<string, any>} */ (m);
  const whole = json(v);
  if (whole === null || whole.length > max || v.kind !== kind || typeof v.attach === 'string') return null;
  if (v.text !== undefined && typeof v.text !== 'string') return null;
  if (v.context !== undefined && !(Array.isArray(v.context) && v.context.every((c) => typeof c === 'string'))) return null;
  if (v.lint !== undefined && typeof v.lint !== 'string') return null;
  if (v.attachments !== undefined && !(Array.isArray(v.attachments) && v.attachments.every(isObject))) return null;
  if ((kind === 'lint' || kind === 'app-check') && v.problems !== undefined && !Array.isArray(v.problems)) return null;
  if (kind === 'event' && !(isObject(v.event) && typeof v.event.blockId === 'string')) return null;
  if (kind === 'agent' && typeof v.from !== 'string') return null;
  // A copy: the turn and the failed reply that keeps it (askedOf) don’t share the session’s record.
  return JSON.parse(whole);
}

/**
 * What continues a session’s turn on its host: the notice, with the record of the turn it continues (checked) riding
 * on it as message.continues, and deliver’s options for that turn: where it spoke, and its summary target.
 * An agent moved off the host since gets the notice alone, as an ordinary turn where it is now.
 * @param {any} rt @param {any} se @param {{ kind: 'notice', text: string, attach?: string }} notice
 */
export function continuing(rt, se, notice) {
  const r = se.remoteTurn;
  if (hostOf(rt.personaFor(se)) !== r.hostId) return { message: notice, opts: {} };
  const threadId = known(rt.s.threads, r.threadId) ? r.threadId : null;
  const o = readOrigin(rt, r.origin);
  if (!o) return { message: notice, opts: { threadId } };
  return { message: { ...notice, continues: o }, opts: { threadId, summarizeTo: o.summarizeTo } };
}

/**
 * deliver made a turn of the notice; begin makes it the turn the notice continues, before anything reads it: its
 * kind, whether it moves on (#69), who woke it, where its answer goes, what it was asked (a request kept in the store
 * stays a ref here, and Retry reads it back: askedOf, askedAgain).
 * @param {any} turn
 */
export function continueAs(turn) {
  const o = turn.asked?.message?.continues;
  if (!o) return;
  turn.origin = o;
  Object.assign(turn, { kind: o.kind, movesOn: o.movesOn, from: o.from, summarizeTo: o.summarizeTo });
  turn.asked = { ...turn.asked, message: o.message ?? null, messageRef: o.messageRef ?? null, lost: o.lost === true };
}
