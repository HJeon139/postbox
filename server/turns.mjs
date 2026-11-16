// An agent with waiting entries starts a turn (designs/architecture/services.md, “Delivery and Turns, built as the
// inbox”, step 2): the root listens to entry.waiting with startFromEntries, which takes one thread’s entries and starts
// the turn through today’s deliver, until Turns starts a turn from entries and builds its input from them (step 3).
// Functions take the Runtime first, as waiting code does until Turns is a service.

import { SENDING, TURN_INPUT } from '../shared/limits.mjs';
import { partEnd } from '../shared/text-parts.mjs';
import { lostEvent } from './app-entries.mjs';
import { combineMessages, plainMessage } from './queue-batch.mjs';
import { newId } from './store.mjs';
import { turnInput } from './turn-input.mjs';

/**
 * Takes the agent’s waiting entries of one thread for a new turn, and starts it. The turn’s id is chosen first, so the
 * take is stored with it before the turn starts, and it rides in the message (`turnId`), which a start held behind a
 * commit carries to the turn it starts later.
 * @param {any} rt @param {string} sessionId
 */
export function startFromEntries(rt, sessionId) {
  const turnId = newId('turn');
  const entries = rt.delivery.take(sessionId, turnId, TURN_INPUT.entries);
  if (!entries.length) return;
  // A plain batch is given turn-input.mjs’s text, built as the turn starts (inputOf); an entry with a message of its own
  // keeps it until Turns owns what reads it (#1427).
  const batch = combineMessages(given(rt, entries));
  // Its plain parts stay with it (`messages`, `as`), for what reads the person’s words or who woke the agent.
  const retried = retryMarks(entries);
  const message = plainBatch(entries)
    ? {
        ...batch,
        kind: 'input',
        as: { kind: batch.kind, from: batch.from },
        messages: batch.messages ?? [batch],
        entries,
        turnId,
        fromEntries: true,
        ...retried,
      }
    : { ...batch, turnId, fromEntries: true, ...retried };
  const lead = leadOf(entries);
  const summarizeTo = summaryOf(rt, lead);
  rt.turnService.run(sessionId, message, { threadId: lead.threadId, ...(summarizeTo ? { summarizeTo } : {}) });
}

/**
 * A turn that takes entries the person’s Retry reopened is the retry (Turns’ retryEntries): marked so, with whom the
 * failed reply already woke, so it doesn’t wake them again (#485). Empty for any other turn. @param {any[]} entries
 */
export function retryMarks(entries) {
  const retried = entries.filter((e) => Array.isArray(e.woken));
  return retried.length ? { retry: true, woken: [...new Set(retried.flatMap((e) => e.woken))] } : {};
}

/** Sources a plain batch is made of: messages to read, and Postbox’s notices riding with them. */
const PLAIN = new Set(['person', 'mention', 'notice']);

/** Whether a turn’s entries are a plain batch. @param {any[]} entries */
const plainBatch = (entries) => entries.every((e) => PLAIN.has(e.source) && !e.message);

/**
 * The text of a plain batch’s turn (designs/rooms-at-scale.md, “What a turn is given”), as the turn starts, so its tail
 * is the room as it is then: its entries, each whole up to its ceiling; the room’s items since the agent’s last turn
 * that aren’t its entries, nor the person’s messages still waiting for it; and the files its messages carry, which the
 * backend places (formatMessage).
 * @param {any} rt @param {any} se @param {{ entries: any[], as: any }} message @param {string} where  the thread the turn speaks in
 */
export function inputOf(rt, se, { entries, as }, where) {
  // Where the turn is: its lead’s thread, not a notice’s riding from another. Each entry is read from its own.
  const threadId = leadOf(entries).threadId;
  const threadOf = new Map(entries.filter((e) => e.itemId).map((e) => [e.itemId, e.threadId]));
  const read = (/** @type {string} */ id) => readItem(rt, threadOf.get(id) ?? threadId, id);
  const waiting = rt.delivery.waiting(se.id);
  // Every entry is given in its own turn, so none is in a tail: the turn’s, and those still waiting, held back by the
  // budget or behind it, the person’s messages too.
  const exclude = [...entries, ...waiting].map((e) => e.itemId).filter(Boolean);
  // A topic or side thread’s own talk since the agent’s last turn there, as lines of the tail. First, so the room’s
  // tail after it doesn’t also name that thread as one with something new.
  const inThread = where !== se.threadId ? rt.memory.threadTail(se, where, exclude) : { lines: [], root: null };
  const room = rt.memory.turnTail(se, exclude);
  const elsewhere = waiting.filter((/** @type {any} */ e) => e.threadId !== threadId && e.source !== 'notice').length;
  const thread = rt.store.pending.thread(threadId) ?? { id: threadId };
  const tail = [...room.tail, ...inThread.lines];
  const root = inThread.root ?? room.root;
  const text = turnInput({ entries, thread, read, tail, notes: room.notes, root, waitingElsewhere: elsewhere });
  const attachments = entries.flatMap((e) => (e.itemId ? (rt.store.pending.item(e.threadId, e.itemId)?.attachments ?? []) : []));
  // The threads the person’s messages link to, each with how to read it (threadRefs, #121), ride with it.
  const links = entries.flatMap((e) => (e.source === 'person' && e.itemId ? rt.threadRefs(e.threadId, read(e.itemId) ?? '') : []));
  // Its plain parts stay on what was asked (`turn.asked`), where what reads them looks; the agent is given the text.
  return { kind: 'input', text, attachments, as, ...(links.length ? { context: links } : {}) };
}

/**
 * An entry’s item as its line reads it, or null when it’s gone: a failed reply says so first, since it may be cut off
 * (#485). @param {any} rt @param {string} threadId @param {string} id
 */
function readItem(rt, threadId, id) {
  const it = rt.store.pending.item(threadId, id);
  return it ? failedNote(it) + String(it.text ?? '') : null;
}

/**
 * What a reply that failed says first, wherever it’s given (#485): that it failed, why, and that it may be cut off;
 * empty for any other item. @param {any} it
 */
export function failedNote(it) {
  if (it?.status !== 'failed') return '';
  const why = String(it.error ?? '').trim();
  const said = why ? `: ${/[.!?]$/.test(why) ? why : `${why}.`}` : '.';
  return `(This reply failed before it finished${said} It may be cut off.)\n\n`;
}

/** The entry a turn is led by: the first that isn’t a notice riding with it from another thread. @param {any[]} entries */
const leadOf = (entries) => entries.find((e) => e.source !== 'notice') ?? entries[0];

/**
 * Where a summary request’s reply is posted: the parent of the thread it summarizes, which Summaries keeps (#1425).
 * Null for any other entry. @param {any} rt @param {any} e
 */
const summaryOf = (rt, e) => (e.message?.summary ? (rt.store.pending.thread(e.threadId)?.parentId ?? null) : null);

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
  const entries = rt.delivery.take(sessionId, turnId, TURN_INPUT.entries, threadId);
  if (!entries.length) return message;
  return { ...combineMessages([message, ...given(rt, entries)]), turnId, ...retryMarks(entries) };
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
  const failed = failedNote(it);
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
