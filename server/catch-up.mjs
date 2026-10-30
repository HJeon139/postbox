// The catch-up at the start of each turn (issue #1): what happened in a conversation since the agent's last turn, from
// the person and the other agents, within a cap, and its marker moved to the end. Moved from server/runtime.mjs.
// Functions take the Runtime first (architecture.md, “What a move may change”).

import { READING } from '../shared/limits.mjs';
import { parseMentions } from '../shared/text.mjs';
import { CATCH_UP_CHARS } from './blocks.mjs';
import { clip } from './helpers.mjs';
import { reactionLines, threadLines } from './thread-summary.mjs';

export const CATCH_UP_ITEMS = 40;
/** How much a summary keeps of the messages that @-mention its agent, which come before the caps above (#484). */
const MENTION_CHARS = 2 * CATCH_UP_CHARS;

/** The catch-up text for a session, or null, and moves its marker to the end of the conversation. */
export function catchUp(rt, se, excludeId = null) {
  if (!se) return null;
  const items = rt.store.items(se.threadId);
  const t = rt.s.threads[se.threadId];
  const at = se.seenItem ? items.findIndex((i) => i.id === se.seenItem) : -1;
  rt.updateSession(se.id, { seenItem: items.at(-1)?.id ?? null });
  // A session from before markers were kept, alone in its conversation, already saw everything addressed to it.
  if (se.seenItem === undefined && (t?.members?.length ?? 0) <= 1 && se.startedAt < (items.at(-1)?.at ?? 0)) return null;
  // Its first catch-up in a topic thread starts with the message the thread is about, unless it holds it already.
  const root = se.seenItem === null ? rt.topicRootLine(se, t) : null;
  const fresh = items.slice(at + 1).filter((i) => i.id !== excludeId && i.sessionId !== se.id);
  const entries = fresh
    // A message addressed to the agent comes whole, up to a bound of its own (#499).
    .map((item) => ({ item, line: rt.describeItem(item, se, mentions(item, se.handle) ? READING.mention : READING.item) }))
    .filter((e) => e.line)
    // Its topic and side threads with something new, each a line it may read (#228); the person’s new reactions (#251).
    .concat([...threadLines(rt, se, items[at]?.at ?? 0), ...reactionLines(rt, se, se.threadId)].map((line) => ({ item: null, line })));
  if (!entries.length) return root && `[Postbox] ${root}`;
  const kept = keepFor(entries, se.handle);
  const left = entries.filter((e) => !kept.includes(e));
  // The mentions this summary gave in full, which pointerIfSeen may point to; one past the cap wasn’t given.
  rt.updateSession(se.id, { givenMentions: kept.filter((e) => mentions(e.item, se.handle)).map((e) => e.item.id) });
  const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
  return `[Postbox] ${root ? `${root}\n\n` : ''}What happened in ${where} since your last turn${left.length ? ` ${leftOut(kept, left, items, se.handle)}` : ''}:\n\n${kept.map((e) => e.line).join('\n\n')}`;
}

/** Whether an item’s text @-mentions this handle. */
const mentions = (item, handle) => typeof item?.text === 'string' && parseMentions(item.text, [handle]).includes(handle);

/**
 * The lines a summary keeps, in order: the messages that @-mention the agent first (#484), the newest within a cap of
 * their own, MENTION_CHARS, past CATCH_UP_ITEMS and CATCH_UP_CHARS; then the newest of the rest within those.
 */
function keepFor(entries, handle) {
  const kept = new Set();
  let size = 0;
  for (const e of entries.filter((x) => mentions(x.item, handle)).reverse()) {
    // The newest always goes, however long: its line is clipped already (describeItem).
    if (kept.size && size + e.line.length > MENTION_CHARS) break;
    kept.add(e);
    size += e.line.length;
  }
  let count = kept.size;
  for (const e of [...entries].reverse()) {
    if (kept.has(e)) continue;
    if (count >= CATCH_UP_ITEMS || size + e.line.length > CATCH_UP_CHARS) break;
    kept.add(e);
    size += e.line.length;
    count++;
  }
  return entries.filter((e) => kept.has(e));
}

/** What a summary left out, by kind, and where read_conversation finds it: skip the newer items. */
function leftOut(kept, left, items, handle) {
  const kinds = new Map();
  for (const { item } of left) {
    const plain = item?.kind === 'agent' ? 'agent' : item?.kind === 'user' ? 'user' : item?.kind === 'block' || item?.kind === 'app' ? 'block' : 'other';
    const kind = mentions(item, handle) ? 'mention' : plain;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const named = [...kinds].map(([kind, n]) => `${n} ${KINDS[kind][n === 1 ? 0 : 1]}`).join(', ');
  const newest = Math.max(-1, ...left.map((e) => (e.item ? items.indexOf(e.item) : -1)));
  // Counted as read_conversation counts, which lists a system line only if it’s a wake.
  const after = items.slice(newest + 1).filter((i) => i.kind !== 'system' || i.variant === 'wake').length;
  const read = newest < 0 ? 'read_conversation has them' : `read_conversation with skip: ${after} has them`;
  // A mention kept ahead of newer items left out means what’s kept isn’t the last N, so the line doesn't say it is.
  const gap = kept.some((e) => e.item && items.indexOf(e.item) < newest);
  const which = gap ? `${kept.length} kept, mentions of you first; ${left.length}` : `the last ${kept.length}; ${left.length} earlier`;
  return `(${which} ${left.length === 1 ? 'item is' : 'items are'} left out: ${named}, and ${read})`;
}

const KINDS = {
  mention: ['mention of you', 'mentions of you'],
  agent: ['message from another agent', 'messages from other agents'],
  user: ['message from the person', 'messages from the person'],
  block: ['block or app', 'blocks and apps'],
  other: ['other update', 'other updates'],
};

/**
 * A queued mention that a summary already gave the agent comes as a pointer to it, so the agent doesn’t read it twice as
 * new (#484). The summary records the mentions it gave (givenMentions), which is how Postbox knows.
 * @param {any} rt @param {any} se @param {any} message
 */
export function pointerIfSeen(rt, se, message) {
  if (message?.kind !== 'agent' || !message.itemId || !se?.seenItem) return message;
  const at = rt.store.items(se.threadId).findIndex((i) => i.id === message.itemId);
  // Only a mention the last summary kept was given: a wake_agent message that names no one, or a mention past the
  // mentions’ cap, may have been left out, so it comes in full.
  if (at < 0 || !(se.givenMentions ?? []).includes(message.itemId)) return message;
  return {
    ...message,
    // Its start, and the call that reads it whole, in case the summary was compacted out of the agent’s context since,
    // or never reached its model (a turn that failed to start, a session started over).
    text: `${message.from}’s message above, which your last summary gave you in full: “${clip(String(message.text ?? ''), 200)}”. It’s addressed to you: act on it now if you haven’t. read_message { id: "${message.itemId}" } has it whole.`,
  };
}
