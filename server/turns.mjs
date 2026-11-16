// An agent with waiting entries starts a turn (designs/architecture/services.md, “Delivery and Turns, built as the
// inbox”, step 2): the root listens to entry.waiting with startFromEntries, which takes one thread’s entries and starts
// the turn through today’s deliver, until Turns starts a turn from entries and builds its input from them (step 3).
// Functions take the Runtime first, as waiting code does until Turns is a service.

import { SENDING } from '../shared/limits.mjs';
import { partEnd } from '../shared/text-parts.mjs';
import { lostEvent } from './app-entries.mjs';
import { combineMessages, plainMessage } from './queue-batch.mjs';
import { newId } from './store.mjs';

/**
 * Takes the agent’s waiting entries of one thread for a new turn, and starts it. The turn’s id is chosen first, so the
 * take is stored with it before the turn starts, and it rides in the message (`turnId`), which a start held behind a
 * commit carries to the turn it starts later.
 * @param {any} rt @param {string} sessionId
 */
export function startFromEntries(rt, sessionId) {
  const turnId = newId('turn');
  const entries = rt.delivery.take(sessionId, turnId, SENDING.message);
  if (!entries.length) return;
  const message = { ...combineMessages(given(rt, entries)), turnId, fromEntries: true };
  rt.deliver(sessionId, message, { threadId: entries[0].threadId });
}

/**
 * A turn the queue or another caller starts in a thread takes the agent’s waiting entries there with what started it,
 * as one batch, as a queued wake used to join the person’s message (#733): the person’s message becomes part of the
 * inbox’s take when the queue releases it (designs/rooms-at-scale.md, “What an entry is”). Only a plain message folds:
 * a command, an answer or an event is a turn of its own, and one marked `entriesWait` keeps them behind it (takePending).
 * Returns the message the turn is given, with its id.
 * @param {any} rt @param {string} sessionId @param {string} threadId @param {any} message
 */
export function withEntries(rt, sessionId, threadId, message) {
  if (message.fromEntries || message.entriesWait || !(plainMessage(message) || message.messages)) return message;
  const turnId = typeof message.turnId === 'string' ? message.turnId : newId('turn');
  const entries = rt.delivery.take(sessionId, turnId, SENDING.message, threadId);
  if (!entries.length) return message;
  return { ...combineMessages([message, ...given(rt, entries)]), turnId };
}

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');

/** Taken entries as today’s deliver takes them. @param {any} rt @param {any[]} entries */
const given = (rt, entries) => entries.map((e) => messageOf(rt, e));

/**
 * One entry as today’s deliver takes it. A mention is its item as it is now, whole up to what one message may carry,
 * with what its failed reply said first (#485): the entry keeps no copy, so a reply settled before its turn wrote the
 * error reads it here. A review carries the event it was sent with; a notice is Postbox’s own words.
 * @param {any} rt @param {any} e
 */
export function messageOf(rt, e) {
  // A plain message carries its place, to sort in a batch; one with a turn of its own is given as it was sent.
  // An app’s event rides in memory; after a restart, its voice line is what’s left of it (app-entries.mjs).
  if (e.source === 'event') return rt.delivery.carriedFor(e.id) ?? lostEvent(rt, e);
  if (e.message) return plainMessage(e.message) ? { ...e.message, at: e.at, seq: e.seq } : e.message;
  if (e.source === 'person') return personMessage(rt, e);
  if (!e.itemId) return { kind: 'notice', text: e.text, at: e.at, seq: e.seq };
  const it = rt.store.pending.item(e.threadId, e.itemId);
  const said = String(it?.text ?? '');
  // Cut as turn-input.mjs’s entryText cuts: at a whole character (#675), with the note copiedLine reads as a copy (#1370).
  const cut = () =>
    `${said.slice(0, partEnd(said, SENDING.message))}… (${count(SENDING.message)} of ${count(said.length)} characters; read_message { id: "${e.itemId}" } has the rest)`;
  const whole = said.length > SENDING.message ? cut() : said;
  const failed = it?.status === 'failed' ? `(This reply failed before it finished${it.error ? `: ${it.error}` : '.'} It may be cut off.)\n\n` : '';
  // Nothing replaces a waiting entry: the sender’s newer posts there are named, as entryLine names them, without the
  // sender’s handle, which a copy of the entry would wake (#1370).
  const since = e.postedSince.length ? `\n(The same sender posted since: ${e.postedSince.map((id) => `[${id}]`).join(', ')})` : '';
  return { kind: 'agent', from: `@${e.from}`, text: failed + whole + since, itemId: e.itemId, at: e.at, seq: e.seq };
}

/**
 * The person’s message as today’s deliver takes it: their item as it is now, so an edit made while it waited is what
 * the agent reads, with the threads it links to (threadRefs). One kept without an item, held when Postbox shut down,
 * is its own text.
 * @param {any} rt @param {any} e
 */
function personMessage(rt, e) {
  if (!e.itemId) return { kind: 'user', text: e.text, attachments: [], at: e.at, seq: e.seq };
  const it = rt.store.pending.item(e.threadId, e.itemId);
  const text = String(it?.text ?? '');
  const refs = rt.threadRefs(e.threadId, text);
  return { kind: 'user', text, attachments: it?.attachments ?? [], itemId: e.itemId, at: e.at, seq: e.seq, ...(refs.length ? { context: refs } : {}) };
}

/**
 * Whether a turn’s end, or a stopped turn’s exit, wakes the agent’s inbox before what waited on the turn and in its
 * thread’s queue (#733’s order, across the queue and the inbox): its oldest entry that can start a turn arrived before
 * every one of those messages. The person’s messages are entries since #1404, so what waits on a turn is mostly what
 * can’t fold into an entry’s turn (a notice, an event, a Send now).
 * @param {any} rt @param {any} se @param {{ pending: any[] }} turn
 */
export function entriesFirst(rt, se, turn) {
  const lead = rt.delivery.waiting(se.id).find((/** @type {any} */ e) => rt.delivery.canStart(e, se));
  if (!lead) return false;
  const before = (/** @type {any} */ a, /** @type {any} */ b) => (a.at ?? 0) < (b.at ?? 0) || ((a.at ?? 0) === (b.at ?? 0) && (a.seq ?? 0) < (b.seq ?? 0));
  const onTurn = turn.pending.flatMap((/** @type {any} */ p) => p.message.messages ?? [p.message]);
  return onTurn.every((m) => before(lead, m));
}
