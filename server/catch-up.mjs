// The catch-up at the start of each turn (issue #1): what happened in a conversation since the agent's last turn, from
// the person and the other agents, within a cap, and its marker moved to the end. Moved from server/runtime.mjs.
// Functions take the Runtime first (architecture.md, “What a move may change”).

import { positionOf } from '../shared/item-index.mjs';
import { READING } from '../shared/limits.mjs';
import { keepFor, leftOut, mentions } from './catch-up-keep.mjs';
import { clip } from './helpers.mjs';
import { reactionLines, threadLines } from './thread-summary.mjs';
import { heldFor } from './wake-cards.mjs';

export { CATCH_UP_ITEMS } from './catch-up-keep.mjs';

/**
 * The catch-up text for a session, or null, and moves its marker to the end of the conversation. exclude: the ids of
 * the messages the turn delivers, every one of a batch, which it reads in full there (#506).
 * @param {any} rt @param {any} se @param {string[]} [exclude]
 */
export function catchUp(rt, se, exclude = []) {
  if (!se) return null;
  const items = rt.store.items(se.threadId);
  const t = rt.s.threads[se.threadId];
  const at = se.seenItem ? positionOf(items, se.seenItem) : -1;
  rt.updateSession(se.id, { seenItem: items.at(-1)?.id ?? null });
  // A session from before markers were kept, alone in its conversation, already saw everything addressed to it.
  if (se.seenItem === undefined && (t?.members?.length ?? 0) <= 1 && se.startedAt < (items.at(-1)?.at ?? 0)) return null;
  // Its first catch-up in a topic thread starts with the message the thread is about, unless it holds it already.
  const root = se.seenItem === null ? rt.topicRootLine(se, t) : null;
  const fresh = items.slice(at + 1).filter((i) => !exclude.includes(i.id) && i.sessionId !== se.id);
  const entries = fresh
    // A message addressed to the agent comes whole, up to a bound of its own (#499).
    .map((item) => ({ item, line: rt.describeItem(item, se, mentions(item, se.handle) ? READING.mention : READING.item) }))
    .filter((e) => e.line)
    // Its topic and side threads with something new, each a line it may read (#228); the person’s new reactions (#251);
    // the messages held for it on a card that waits for the person (#693).
    .concat([...threadLines(rt, se, items[at]?.at ?? 0), ...reactionLines(rt, se, se.threadId), ...heldFor(rt, se)].map((line) => ({ item: null, line })));
  if (!entries.length) return root && `[Postbox] ${root}`;
  const kept = keepFor(entries, se.handle);
  const left = entries.filter((e) => !kept.includes(e));
  // The mentions this summary gave in full, which pointerIfSeen may point to: one past the cap wasn’t given, and one
  // cut at READING.mention (a message may be 50,000 characters) was given only in part, so it comes again whole.
  const whole = (/** @type {any} */ e) => mentions(e.item, se.handle) && String(e.item.text ?? '').length <= READING.mention;
  rt.updateSession(se.id, { givenMentions: kept.filter(whole).map((e) => e.item.id) });
  const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
  return `[Postbox] ${root ? `${root}\n\n` : ''}What happened in ${where} since your last turn${left.length ? ` ${leftOut(kept, left, items, se.handle)}` : ''}:\n\n${kept.map((e) => e.line).join('\n\n')}`;
}

/**
 * A mention that a summary already gave the agent comes as a pointer to it, so the agent doesn’t read it twice as new
 * (#484): an agent’s queued wake, the person’s message posted while the agent was busy elsewhere (#506), and each
 * message of a batch. The summary records the mentions it gave (givenMentions), which is how Postbox knows.
 * @param {any} rt @param {any} se @param {any} message
 */
export function pointerIfSeen(rt, se, message) {
  // A batch: each of its messages, and its text as theirs joined, as combineMessages makes it.
  if (Array.isArray(message?.messages)) {
    const messages = message.messages.map((/** @type {any} */ m) => pointerIfSeen(rt, se, m));
    return { ...message, messages, text: messages.map((m) => m.text ?? '').join('\n\n') };
  }
  // A command is the whole prompt, so it’s never a pointer, though a Retry delivers it again after a summary (#67).
  if ((message?.kind !== 'agent' && message?.kind !== 'user') || message.slash || !message.itemId || !se?.seenItem) return message;
  const at = positionOf(rt.store.items(se.threadId), message.itemId);
  // Only a mention the last summary kept was given: a wake_agent message that names no one, or a mention past the
  // mentions’ cap, may have been left out, so it comes in full.
  if (at < 0 || !(se.givenMentions ?? []).includes(message.itemId)) return message;
  return {
    ...message,
    // Its start, and the call that reads it whole, in case the summary was compacted out of the agent’s context since,
    // or never reached its model (a turn that failed to start, a session started over).
    text: `${message.kind === 'user' ? 'The person' : message.from}’s message above, which your last summary gave you in full: “${clip(String(message.text ?? ''), 200)}”. It’s addressed to you: act on it now if you haven’t. read_message { id: "${message.itemId}" } has it whole.`,
  };
}
