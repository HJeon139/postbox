// What a turn is given (designs/rooms-at-scale.md, “What a turn is given” and “The budget”): the agent’s waiting
// entries in one thread, each whole up to a ceiling, then a bounded tail of the rest of the room since its last turn,
// and one line on where the rest is. It reads nothing itself: the caller gives it the entries a turn took, a way to
// read an item’s text, and the lines of the tail, so it depends on no service.

import { READING, TURN_INPUT } from '../shared/limits.mjs';
import { partEnd } from '../shared/text-parts.mjs';
import { backTo } from './reply-back.mjs';

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
 * @property {boolean} [bounce]  a reply that came back on its own (reply-back.mjs)
 * @property {string[]} [woken]  on an entry the person’s Retry reopened, whom its failed reply already woke (#485)
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

/**
 * Who an entry is from: the person, an agent by its handle, or Postbox for what no one wrote. `person` names the
 * person among several (#1742); with none given it is “The person”.
 */
function sender(/** @type {Entry} */ e, /** @type {(e: Entry) => string} */ person) {
  if (e.from === 'you') return person(e);
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
 * @param {(e: Entry) => string} [person]  who a person’s entry is from, as shared/profile.mjs’s senderName says it
 */
export function entryLine(e, read, person = () => 'The person') {
  const again = e.resend ? ', sent again in case it didn’t reach you' : '';
  // Without the sender’s handle: a second line that named it would wake it when an agent copies the entry.
  const since = e.postedSince?.length ? `\n(The same sender posted since: ${e.postedSince.map((id) => `[${id}]`).join(', ')})` : '';
  return `[${e.itemId ?? e.id}] ${sender(e, person)}${SOURCE_NOTE[e.source] ?? ''}, ${when(e.at)}${again}: ${entryText(e, read)}${since}`;
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

/**
 * Agents named as a list: “@a”, “@a and @b”, and “@a, @b and @c” for three or more (#1974).
 * @param {string[]} hs  handles, without @
 */
function handles(hs) {
  const named = hs.map((h) => `@${h}`);
  if (named.length < 3) return named.join(' and ');
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/**
 * Where the reply goes as well as posting (#1518): back to the agents whose mentions started the turn, unless it
 * @-mentions an agent. Nothing for any other turn. A turn only replies that came back woke is told how its exchange
 * ends, as reply-back.mjs ends it: a reaction to the reply ends it whatever the turn writes without an @-mention
 * (#1553), and so does its second reply in a row to the same agent that only writes (#1591), which this one would be
 * for the agents in `wroteOnly`. The person’s Retry still owes its reply (empty-reply.mjs), which goes back.
 * @param {Entry[]} entries @param {string[]} wroteOnly  whom the agent’s last replies here, which only wrote, were for
 */
function replyGoes(entries, wroteOnly) {
  const to = backTo(entries);
  if (!to.length) return '.';
  const goes = ` and goes back to ${handles(to)}. @-mention another agent to hand off to them instead.`;
  const asked = entries.filter((e) => e.source !== 'notice');
  if (!asked.every((e) => e.bounce === true)) return goes;
  const react = 'If the exchange is done, react to the reply: then your reply this turn doesn’t go back to its sender. An @-mention still wakes whom it names.';
  // A Retry’s entries carry whom its failed reply woke, as retryMarks (turns.mjs) reads them.
  if (entries.some((e) => Array.isArray(e.woken))) return `${goes} ${react}`;
  const end = `${react} You can also end without writing anything.`;
  // Per exchange: only the agents its last reply in words went to. The others get this one as any reply.
  const again = to.filter((h) => wroteOnly.includes(h));
  if (!again.length) return `${goes} ${end}`;
  const rest = to.filter((h) => !wroteOnly.includes(h));
  const first = rest.length ? ` and goes back to ${handles(rest)}. @-mention another agent to hand off to them instead.` : '.';
  const second = `Your last reply to ${handles(again)} only wrote, so this one goes back to ${handles(again)} only if you do work this turn (more than reading the room and reacting)`;
  return `${first} ${second}: a second in a row to the same agent that only writes doesn’t wake it, so @-mention whoever must act on it or answer it. ${end}`;
}

/**
 * That the agents in `reacted` woke this turn only by @-mentions from turns that reacted to its reply and did no work
 * (#1974; reply-back.mjs, markReacted). The mention wakes it all the same, so it is told it may end the exchange.
 * @param {string[]} reacted
 */
function reactedLine(reacted) {
  if (!reacted.length) return '';
  return ` ${handles(reacted)} reacted to your reply and did no work. If nothing is asked of you, react and end with no words.`;
}

/** The first part: the entries, with where the reply posts and goes, who only reacted, and what waits elsewhere. */
function entriesPart({ entries, thread, read, person, waitingElsewhere, wroteOnly, reacted }) {
  const n = entries.length;
  const one = waitingElsewhere === 1;
  const more = waitingElsewhere
    ? ` ${count(waitingElsewhere)} more ${one ? 'waits in another thread, and starts' : 'wait in other threads, and start'} your next turn.`
    : '';
  const head = `[Postbox] ${count(n)} ${n === 1 ? 'message' : 'messages'} for you ${place(thread)}. Your reply posts there${replyGoes(entries, wroteOnly)}${reactedLine(reacted)}${more}`;
  return [head, ...entries.map((/** @type {Entry} */ e) => entryLine(e, read, person))].join('\n\n');
}

/**
 * The second and third parts: the tail, and the line that says what it left out and how to find it. The notes are the
 * tail’s newest lines, so they count within its limits and are kept first.
 */
function tailPart({ tail, notes, thread }) {
  const { kept, left } = tailOf([...tail, ...notes]);
  const head = '[Postbox] Also since your last turn, not addressed to you';
  // read_conversation reads the conversation unless it’s given the thread, and a thread’s tail holds both.
  const there = thread.kind === 'topic' || thread.kind === 'side' ? `, with thread: "${thread.id}" for this thread’s items` : '';
  if (!kept.length) {
    if (!left) return null;
    const them = left === 1 ? '1 item, not shown here. read_conversation has it' : `${count(left)} items, not shown here. read_conversation has them`;
    return `${head}: ${them} in order${there}, and search_conversation finds one by its words.`;
  }
  const rest = left
    ? ` (the last ${count(kept.length)} of ${count(kept.length + left)} items; read_conversation has the rest in order${there}, and search_conversation finds one by its words)`
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
 * @param {string[]} [input.wroteOnly]  whom the agent’s last replies in the thread, which only wrote, were for (reply-back.mjs)
 * @param {string[]} [input.reacted]  who woke it only from turns that reacted to its reply and did no work (reply-back.mjs)
 * @param {(e: Entry) => string} [input.person]  who a person’s entry is from; “The person” with none given
 * @param {string | null} [input.about]  who the people say they are, as shared/profile.mjs’s aboutPeople words it; none while no one has saved a profile
 */
export function turnInput({
  entries,
  thread,
  read,
  person,
  tail = [],
  notes = [],
  root = null,
  waitingElsewhere = 0,
  stopped = [],
  wroteOnly = [],
  reacted = [],
  about = null,
}) {
  const halted = stopped.length
    ? `[Postbox] The person stopped you before a turn started from ${stopped.map((id) => `[${id}]`).join(', ')}. read_message reads one.`
    : null;
  // Who the person says they are (#558), after what the turn is for and apart from the room’s tail, which is cut to its newest.
  return [
    root && `[Postbox] ${root}`,
    entriesPart({ entries, thread, read, person, waitingElsewhere, wroteOnly, reacted }),
    halted,
    about,
    tailPart({ tail, notes, thread }),
  ]
    .filter(Boolean)
    .join('\n\n');
}
