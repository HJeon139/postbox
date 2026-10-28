// The catch-up at the start of each turn (issue #1): what happened in a conversation since the agent's last turn, from
// the person and the other agents, within a cap, and its marker moved to the end. Moved from server/runtime.mjs.
// Functions take the Runtime first (architecture.md, “What a move may change”).

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
  const lines = items
    .slice(at + 1)
    .filter((i) => i.id !== excludeId && i.sessionId !== se.id)
    .map((i) => rt.describeItem(i, se))
    .filter(Boolean)
    // Its topic and side threads with something new, each a line it may read (#228); the person’s new reactions (#251).
    .concat(threadLines(rt, se, items[at]?.at ?? 0), reactionLines(rt, se, se.threadId));
  if (!lines.length) return root && `[Postbox] ${root}`;
  const kept = [];
  let size = 0;
  for (const line of lines.reverse()) {
    if (kept.length >= CATCH_UP_ITEMS || size + line.length > CATCH_UP_CHARS) break;
    kept.unshift(line);
    size += line.length;
  }
  const dropped = lines.length - kept.length;
  const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
  return `[Postbox] ${root ? `${root}\n\n` : ''}What happened in ${where} since your last turn${dropped ? ` (the last ${kept.length}; ${dropped} earlier ${dropped === 1 ? 'item is' : 'items are'} left out, and read_conversation has them)` : ''}:\n\n${kept.join('\n\n')}`;
}
