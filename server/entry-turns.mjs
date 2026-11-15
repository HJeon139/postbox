// An agent with waiting entries starts a turn (designs/architecture/services.md, “Delivery and Turns, built as the
// inbox”, step 2): the root listens to entry.waiting with startFromEntries, which takes one thread’s entries and starts
// the turn through today’s deliver, until Turns starts a turn from entries and builds its input from them (step 3).
// Functions take the Runtime first, as waiting code does until Turns is a service.

import { SENDING } from '../shared/limits.mjs';
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

/** Taken entries as today’s deliver takes them. @param {any} rt @param {any[]} entries */
const given = (rt, entries) => entries.map((e) => messageOf(rt, e));

/**
 * One entry as today’s deliver takes it. A mention is its item as it is now, whole up to what one message may carry,
 * with what its failed reply said first (#485): the entry keeps no copy, so a reply settled before its turn wrote the
 * error reads it here. A review carries the event it was sent with; a notice is Postbox’s own words.
 * @param {any} rt @param {any} e
 */
export function messageOf(rt, e) {
  if (e.message) return { ...e.message, at: e.at, seq: e.seq };
  if (!e.itemId) return { kind: 'notice', text: e.text, at: e.at, seq: e.seq };
  const it = rt.store.pending.item(e.threadId, e.itemId);
  const said = String(it?.text ?? '');
  const whole = said.length > SENDING.message ? `${said.slice(0, SENDING.message)}… (cut; read_message ${e.itemId} reads it whole)` : said;
  const failed = it?.status === 'failed' ? `(This reply failed before it finished${it.error ? `: ${it.error}` : '.'} It may be cut off.)\n\n` : '';
  // Nothing replaces a waiting entry: the sender’s newer posts there are named, for read_message (“posted since”).
  const since = e.postedSince.length ? `\n\n(@${e.from} posted since: ${e.postedSince.join(', ')}. read_message reads each.)` : '';
  return { kind: 'agent', from: `@${e.from}`, text: failed + whole + since, itemId: e.itemId, at: e.at, seq: e.seq };
}
