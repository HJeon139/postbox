// What a turn is given (designs/rooms-at-scale.md, “What a turn is given” and “The budget”): the agent’s waiting
// entries in one thread, each whole up to a ceiling, then a bounded tail of the rest of the room since its last turn,
// and one line on where the rest is. It reads nothing itself: the caller gives it the entries a turn took, a way to
// read an item’s text, and the lines of the tail, so it depends on no service.

import { READING, TURN_INPUT } from '../shared/limits.mjs';
import { partEnd } from '../shared/text-parts.mjs';

/**
 * An inbox entry, as the design’s entry table gives it.
 * @typedef {object} Entry
 * @property {string} id
 * @property {string} threadId
 * @property {string} [itemId]  the item it comes from, when there is one
 * @property {string} [text]  its own text, for an entry with no item
 * @property {'person'|'mention'|'review'|'answer'|'scheduled'|'command'|'check'|'event'|'notice'} source
 * @property {string} [from]  the sender’s handle, or “you” for the person; none for Postbox
 * @property {number} at
 * @property {boolean} [resend]
 * @property {string[]} [postedSince]  ids of the sender’s newer posts while it waited
 */

/** What each source is, said after who it is from. A mention or the person’s message needs no words. */
const SOURCE_NOTE = {
  review: ', a review of your block',
  answer: ', an answer to what you showed',
  scheduled: ', the wake you scheduled',
  command: ', a command',
  check: ', a check of your work',
  event: ', from an app',
};

/** Who an entry is from: the person, an agent by its handle, or Postbox for what no one wrote. */
function sender(/** @type {Entry} */ e) {
  if (e.from === 'you') return 'The person';
  return e.from ? `@${e.from}` : 'Postbox';
}

/** When an entry’s item became final, to the minute. */
const when = (/** @type {number} */ at) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

const count = (/** @type {number} */ n) => n.toLocaleString('en-US');

/**
 * An entry’s text, whole up to the ceiling for one entry, then cut with the id that reads the rest. An entry whose
 * item is gone says so: delete is plain, and the entry kept no copy.
 * @param {Entry} e @param {(itemId: string) => string | null} read
 */
function entryText(e, read) {
  const text = e.itemId ? read(e.itemId) : (e.text ?? '');
  if (text === null) return '(deleted since it was sent)';
  if (text.length <= READING.mention) return text;
  const rest = e.itemId ? `; read_message { id: "${e.itemId}" } has the rest` : '';
  // At a whole character: a cut between the halves of a pair leaves a lone half, which shows as a box (#675).
  return `${text.slice(0, partEnd(text, READING.mention))}… (${count(READING.mention)} of ${count(text.length)} characters${rest})`;
}

/**
 * One entry as the turn gives it: its id, who it is from, what it is and when, then its text. What Delivery counts
 * against the budget for all entries in a turn is this line’s length.
 * @param {Entry} e @param {(itemId: string) => string | null} read
 */
export function entryLine(e, read) {
  const again = e.resend ? ', sent again in case it didn’t reach you' : '';
  // Without the sender’s handle: a second line that named it would wake it when an agent copies the entry.
  const since = e.postedSince?.length ? `\n(The same sender posted since: ${e.postedSince.map((id) => `[${id}]`).join(', ')})` : '';
  return `[${e.itemId ?? e.id}] ${sender(e)}${SOURCE_NOTE[e.source] ?? ''}, ${when(e.at)}${again}: ${entryText(e, read)}${since}`;
}

/**
 * The lines of the tail a turn keeps: the newest, within the tail’s count and size, in their order.
 * @param {string[]} lines  the items since the agent’s last turn that aren’t its entries, oldest first, one line each
 * @returns {{ kept: string[], left: number }}
 */
export function tailOf(lines) {
  let size = 0;
  let from = lines.length;
  while (from > 0 && lines.length - from < TURN_INPUT.tailItems && size + lines[from - 1].length <= TURN_INPUT.tailChars) {
    from--;
    size += lines[from].length;
  }
  return { kept: lines.slice(from), left: from };
}

/** Where a turn’s entries are, and so where its reply posts. */
function place(/** @type {{ id: string, kind?: string, title?: string }} */ thread) {
  if (thread.kind === 'topic' || thread.kind === 'side') return `in the thread “${thread.title ?? ''}” (${thread.id})`;
  return thread.kind === 'room' ? 'in this room' : 'in this conversation';
}

/** The first part: the entries, with where the reply posts and what waits elsewhere. */
function entriesPart({ entries, thread, read, waitingElsewhere }) {
  const n = entries.length;
  const one = waitingElsewhere === 1;
  const more = waitingElsewhere
    ? ` ${count(waitingElsewhere)} more ${one ? 'waits in another thread, and starts' : 'wait in other threads, and start'} your next turn.`
    : '';
  const head = `[Postbox] ${count(n)} ${n === 1 ? 'message' : 'messages'} for you ${place(thread)}. Your reply posts there.${more}`;
  return [head, ...entries.map((/** @type {Entry} */ e) => entryLine(e, read))].join('\n\n');
}

/**
 * The second and third parts: the tail, and the line that says what it left out and how to find it. The notes are the
 * tail’s newest lines, so they count within its limits and are kept first.
 */
function tailPart({ tail, notes }) {
  const { kept, left } = tailOf([...tail, ...notes]);
  const head = '[Postbox] Also since your last turn, not addressed to you';
  if (!kept.length) {
    if (!left) return null;
    const them = left === 1 ? '1 item, not shown here. read_conversation has it' : `${count(left)} items, not shown here. read_conversation has them`;
    return `${head}: ${them} in order, and search_conversation finds one by its words.`;
  }
  const rest = left
    ? ` (the last ${count(kept.length)} of ${count(kept.length + left)} items; read_conversation has the rest in order, and search_conversation finds one by its words)`
    : '';
  return [`${head}${rest}:`, ...kept].join('\n\n');
}

/**
 * The text a turn starts with.
 * @param {object} input
 * @param {Entry[]} input.entries  what the turn took: one thread’s waiting entries, oldest first
 * @param {{ id: string, kind?: string, title?: string }} input.thread  that thread
 * @param {(itemId: string) => string | null} input.read  an item’s text, or null when it is gone
 * @param {string[]} [input.tail]  the items since the agent’s last turn that aren’t its entries, oldest first, one line each
 * @param {string[]} [input.notes]  the tail’s newest lines: threads with something new, the person’s reactions
 * @param {string | null} [input.root]  the message a topic thread is about, on the agent’s first turn there
 * @param {number} [input.waitingElsewhere]  entries waiting in other threads
 * @param {string[]} [input.stopped]  ids of entries the person’s Stop kept from starting a turn
 */
export function turnInput({ entries, thread, read, tail = [], notes = [], root = null, waitingElsewhere = 0, stopped = [] }) {
  const halted = stopped.length
    ? `[Postbox] The person stopped you before a turn started from ${stopped.map((id) => `[${id}]`).join(', ')}. read_message reads one.`
    : null;
  return [root && `[Postbox] ${root}`, entriesPart({ entries, thread, read, waitingElsewhere }), halted, tailPart({ tail, notes })]
    .filter(Boolean)
    .join('\n\n');
}
