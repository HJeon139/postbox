// The catch-up at the start of each turn (issue #1): what happened in a conversation since the agent's last turn, from
// the person and the other agents, within a cap, and its marker moved to the end. Functions take Memory first
// (designs/architecture/services.md, “Memory”).

import { positionOf } from '../shared/item-index.mjs';
import { READING } from '../shared/limits.mjs';
import { keepFor, leftOut, mentions } from './catch-up-keep.mjs';
import { reactionLines, threadLines } from './thread-catch-up.mjs';

export { CATCH_UP_ITEMS } from './catch-up-keep.mjs';

/**
 * The catch-up text for a session, or null, and moves its marker to the end of the conversation. exclude: the ids of
 * the messages the turn delivers, every one of a batch, which it reads in full there (#506).
 * @param {import('./memory-service.mjs').Memory} memory @param {any} se @param {string[]} [exclude]
 */
export function catchUp(memory, se, exclude = []) {
  if (!se) return null;
  const items = memory.store.items(se.threadId);
  const t = memory.store.state.threads[se.threadId];
  const at = se.seenItem ? positionOf(items, se.seenItem) : -1;
  memory.sessions.update(se.id, { seenItem: items.at(-1)?.id ?? null });
  // A session from before markers were kept, alone in its conversation, already saw everything addressed to it.
  if (se.seenItem === undefined && (t?.members?.length ?? 0) <= 1 && se.startedAt < (items.at(-1)?.at ?? 0)) return null;
  // Its first catch-up in a topic thread starts with the message the thread is about, unless it holds it already.
  const root = se.seenItem === null ? memory.topicRootLine(se, t) : null;
  const fresh = items.slice(at + 1).filter((i) => !exclude.includes(i.id) && i.sessionId !== se.id);
  const entries = fresh
    // A message addressed to the agent comes whole, up to a bound of its own (#499).
    .map((item) => ({ item, line: memory.describeItem(item, se, mentions(item, se.handle) ? READING.mention : READING.item) }))
    .filter((e) => e.line)
    // Its topic and side threads with something new, each a line it may read (#228); the person’s new reactions (#251);
    // the messages held for it on a card that waits for the person (#693), which the catchUpLines port gives.
    .concat(
      [...threadLines(memory, se, items[at]?.at ?? 0), ...reactionLines(memory, se, se.threadId), ...memory.catchUpLines(se)].map((line) => ({
        item: null,
        line,
      })),
    );
  if (!entries.length) return root && `[Postbox] ${root}`;
  const kept = keepFor(entries, se.handle);
  const left = entries.filter((e) => !kept.includes(e));
  const where = t?.kind === 'room' ? 'this room' : t?.kind === 'topic' ? 'this thread' : 'this conversation';
  return `[Postbox] ${root ? `${root}\n\n` : ''}What happened in ${where} since your last turn${left.length ? ` ${leftOut(kept, left, items, se.handle)}` : ''}:\n\n${kept.map((e) => e.line).join('\n\n')}`;
}

/**
 * What a turn given turn-input.mjs’s text reads of the room besides its entries (#1427; designs/rooms-at-scale.md, “What
 * a turn is given”): the items since the agent’s last turn, one line each as read_conversation gives them, without its
 * own and without `exclude` (the turn’s entries, and the person’s messages still waiting for it); the lines on threads
 * with something new, the person’s reactions and what waits for it on a card; and, on its first turn in a topic thread,
 * the message the thread is about. Moves its marker to the end of the conversation, as catchUp does.
 * @param {import('./memory-service.mjs').Memory} memory @param {any} se @param {string[]} exclude
 * @returns {{ tail: string[], notes: string[], root: string | null }}
 */
export function turnTail(memory, se, exclude) {
  const items = memory.store.items(se.threadId);
  const t = memory.store.state.threads[se.threadId];
  const at = se.seenItem ? positionOf(items, se.seenItem) : -1;
  memory.sessions.update(se.id, { seenItem: items.at(-1)?.id ?? null });
  const root = se.seenItem === null ? memory.topicRootLine(se, t) : null;
  const fresh = items.slice(at + 1).filter((i) => !exclude.includes(i.id) && i.sessionId !== se.id && (i.kind !== 'system' || i.variant === 'wake'));
  const tail = fresh.flatMap((i) => {
    const line = memory.readLine(i, se);
    return line ? [`[${i.id}] ${line}`] : [];
  });
  const notes = [...threadLines(memory, se, items[at]?.at ?? 0), ...reactionLines(memory, se, se.threadId), ...memory.catchUpLines(se)];
  return { tail, notes, root: root ?? null };
}

/**
 * An item brought forward to the end of its thread (bringForward): a session whose catch-up marker was the item now
 * reads on from the stub, where the item was, so what came after it isn’t skipped. In the conversation the marker is
 * seenItem. A topic or side thread has no members, and its marker is seenIn for that thread on the conversation’s
 * sessions (threadCatchUp, #1041). Pending, so a marker a catch-up just wrote behind a held commit moves too (#956).
 * Moved from server/runtime.mjs.
 * @param {import('./memory-service.mjs').Memory} memory @param {string} threadId @param {string} id  the item moved @param {string} stubId  the stub in its place
 */
export function moveMarkers(memory, threadId, id, stubId) {
  const conv = memory.threads.lineage(threadId, (/** @type {string} */ x) => memory.store.pending.thread(x)).at(-1);
  const marker = (/** @type {any} */ se) => (threadId === conv ? se.seenItem : se.seenIn?.[threadId]);
  const onStub = (/** @type {any} */ now) => (threadId === conv ? { seenItem: stubId } : { seenIn: { ...(now.seenIn ?? {}), [threadId]: stubId } });
  for (const se of memory.sessions.pendingIn(conv)) if (marker(se) === id) memory.sessions.update(se.id, onStub);
}
