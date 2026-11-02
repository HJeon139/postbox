// An event the shared reducer rejects (#609, #610; designs/508/609-reducer-throw.md). The store numbers it, writes it
// and holds it as rejected, so numbering never skips, a throw neither closes the store nor crashes the writer, and
// every load gives the same result. What the page and since() get is a stand-in that carries nothing, since the
// reducer's message can quote what it was given. What the log gets is the stand-in with the original inside it, for an
// emit or a held release; a commit's original was written before it was applied. The reducer's contract, that a
// handler which throws changes nothing, is held by tests/state-reject-contract.test.mjs.

import { apply } from '../shared/state.mjs';

/** @typedef {{ count: number, first: { seq: number, type: string, error: string }[] }} Rejected */

/** The stand-in's type: no producer may emit it. */
export const REJECTED = 'rejected';
/** How many rejections are kept by seq; the rest are counted, as `lost` keeps a range and a count. */
const KEEP = 20;

/**
 * The names no producer may emit: the stand-in, and the event stream's own frames. A frame name emitted as an event
 * would reach the reducer, throw and be held as rejected; refusing it first keeps it out of the log. The four frame
 * names are a naming concern, not a rejection one: they move to #630's `RESERVED` in shared/state.mjs at the seam,
 * and only `rejected` stays here.
 */
const RESERVED_TYPES = new Set([REJECTED, 'cursor', 'status', 'epoch', 'resync']);

/** Refuses a producer's event of a reserved type, before anything is numbered. @param {string} type */
export function refuseReserved(type) {
  if (RESERVED_TYPES.has(type))
    throw Object.assign(new Error(`“${type}” is a reserved name: no event may take it (server/store-reject.mjs).`), { code: 'ERESERVED' });
}

/** What the page, the stream and since() get for a rejected seq: its place, and nothing of the event. @param {number} seq */
export const standIn = (seq) => ({ seq, type: REJECTED, data: {} });

/** The line the log keeps for a rejected emit or held release: the stand-in, with the original and why. */
export const loggedStandIn = (ev, error) => ({ seq: ev.seq, type: REJECTED, data: { event: { type: ev.type, data: ev.data }, error: messageOf(error) } });

const messageOf = (error) => String(error?.message ?? error);

/**
 * Keeps a rejection on `holder` (the store, or a load's candidate): a count, and the first few by seq.
 * @param {{ rejected: { count: number, first: { seq: number, type: string, error: string }[] } | null }} holder
 * @param {number} seq @param {string} type @param {unknown} error
 */
export function noteRejected(holder, seq, type, error) {
  holder.rejected ??= { count: 0, first: [] };
  holder.rejected.count++;
  if (holder.rejected.first.length < KEEP) holder.rejected.first.push({ seq, type, error: messageOf(error) });
}

/**
 * Applies a numbered live event to the store's state (Store.record), or holds it as rejected: kept and counted on the
 * store, and logged once. Decides both of the seq's lines in one place: `line`, what the log keeps (the JSON made
 * before applying, as it was emitted, or the stand-in with it inside), and `kept`, what the since() backlog keeps (the
 * same JSON, or nothing for a rejected one, since since() from before it resyncs). `heard` is what listeners get.
 * @param {any} store @param {any} ev @returns {{ line: string, kept: string | null, heard: any, error: unknown }}
 */
export function applyOrHold(store, ev) {
  const line = JSON.stringify(ev);
  try {
    apply(store.state, ev.type, ev.data);
    return { line, kept: line, heard: ev, error: null };
  } catch (error) {
    noteRejected(store, ev.seq, ev.type, error);
    store.lastRejected = ev.seq;
    // Its seq and type only: the reducer's message can quote what it was given (store.rejected keeps it, on the server).
    console.error(`The store couldn’t apply event ${ev.seq} (${ev.type}), and keeps it as rejected.`);
    return { line: JSON.stringify(loggedStandIn(ev, error)), kept: null, heard: standIn(ev.seq), error };
  }
}

/** What a rejected commit's opId keeps, live and on replay. @param {number} seq @param {string} type @param {unknown} error */
export const opRecord = (seq, type, error) => ({ seq, type, error: messageOf(error) });

/**
 * The error the caller of an emit or a commit gets: the event is in the log, held as rejected. Its message names the
 * seq and type only, since a tool returns `message` to the agent (server/mcp.mjs); the reducer's error is the cause.
 */
export const rejectedError = (seq, type, cause) =>
  Object.assign(new Error(`The store couldn’t apply event ${seq} (${type}), so it’s kept as rejected.`), { code: 'EREJECTED', seq, type, cause });
