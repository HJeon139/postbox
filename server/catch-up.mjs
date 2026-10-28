// The catch-up at the start of each turn (issue #1): what happened in a conversation since the agent's last turn, from
// the person and the other agents, within a cap, and its marker moved to the end. Moved from server/runtime.mjs.
// Functions take the Runtime first (architecture.md, “What a move may change”).

import { parseMentions } from '../shared/text.mjs';
import { CATCH_UP_CHARS } from './blocks.mjs';
import { reactionLines, threadLines } from './thread-summary.mjs';

const CATCH_UP_ITEMS = 40;

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
    .map((item) => ({ item, line: rt.describeItem(item, se) }))
    .filter((e) => e.line)
    // Its topic and side threads with something new, each a line it may read (#228); the person’s new reactions (#251).
    .concat([...threadLines(rt, se, items[at]?.at ?? 0), ...reactionLines(rt, se, se.threadId)].map((line) => ({ item: null, line })));
  if (!entries.length) return root && `[Postbox] ${root}`;
  const kept = keepFor(entries, se.handle);
  const left = entries.filter((e) => !kept.includes(e));
  const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
  return `[Postbox] ${root ? `${root}\n\n` : ''}What happened in ${where} since your last turn${left.length ? ` ${leftOut(kept, left, items)}` : ''}:\n\n${kept.map((e) => e.line).join('\n\n')}`;
}

/** Whether an item’s text @-mentions this handle. */
const mentions = (item, handle) => typeof item?.text === 'string' && parseMentions(item.text, [handle]).includes(handle);

/**
 * The lines a summary keeps, in order: every message that @-mentions the agent, which is never left out (#484), then
 * the newest of the rest within CATCH_UP_ITEMS and CATCH_UP_CHARS.
 */
function keepFor(entries, handle) {
  const mine = new Set(entries.filter((e) => mentions(e.item, handle)));
  let size = [...mine].reduce((n, e) => n + e.line.length, 0);
  let count = mine.size;
  const kept = new Set(mine);
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
function leftOut(kept, left, items) {
  const kinds = new Map();
  for (const { item } of left) {
    const kind = item?.kind === 'agent' ? 'agent' : item?.kind === 'user' ? 'user' : item?.kind === 'block' || item?.kind === 'app' ? 'block' : 'other';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const named = [...kinds].map(([kind, n]) => `${n} ${KINDS[kind][n === 1 ? 0 : 1]}`).join(', ');
  const newest = Math.max(-1, ...left.map((e) => (e.item ? items.indexOf(e.item) : -1)));
  const read = newest < 0 ? 'read_conversation has them' : `read_conversation with skip: ${items.length - 1 - newest} has them`;
  return `(the last ${kept.length}; ${left.length} earlier ${left.length === 1 ? 'item is' : 'items are'} left out: ${named}, and ${read})`;
}

const KINDS = {
  agent: ['message from another agent', 'messages from other agents'],
  user: ['message from the person', 'messages from the person'],
  block: ['block or app', 'blocks and apps'],
  other: ['other update', 'other updates'],
};

/**
 * A queued mention that a summary already gave the agent comes as a pointer to it, so the agent doesn’t read it twice as
 * new (#484). The summary moved its marker past the mention’s item, which is how Postbox knows it was given.
 * @param {any} rt @param {any} se @param {any} message
 */
export function pointerIfSeen(rt, se, message) {
  if (message?.kind !== 'agent' || !message.itemId || !se?.seenItem) return message;
  const items = rt.store.items(se.threadId);
  const at = items.findIndex((i) => i.id === message.itemId);
  const seen = items.findIndex((i) => i.id === se.seenItem);
  // Only a mention is sure to have been given: the summary never leaves one out (keepFor). A wake_agent message that
  // names no one may have been left out, so it comes in full.
  if (at < 0 || seen < 0 || at > seen || !mentions(items[at], se.handle)) return message;
  return {
    ...message,
    text: `${message.from}’s message above, which your last summary gave you in full. It’s addressed to you: act on it now if you haven’t.`,
  };
}
