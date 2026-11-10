// Queue batches keep per-agent order and thread boundaries; later turns can supersede a waker’s old request (#374).
import { positionOf } from '../shared/item-index.mjs';

/**
 * Whether an agent's last reply failed and no turn has run since (#1146, the person's choice): what waits for it in the
 * queues, the person's messages and other agents' wakes alike, is held until the person writes to it or retries the
 * reply. A turn's start ends the hold; one that doesn't move on (a lint pass, an app check) keeps the failed reply as
 * its need, so the hold is back at its end. Dismiss ends it too. From the pending session, as a held commit may hold the
 * failure's own write.
 * @param {any} rt @param {string} sessionId
 */
export function heldAfterFailure(rt, sessionId) {
  return (rt.store.pending.session(sessionId) ?? rt.s.sessions[sessionId])?.state === 'failed';
}

/**
 * What can go from a thread's queue, by agent, in order for each. release: an agent held after a failure that the
 * person's message releases now (heldAfterFailure).
 * @param {any} rt @param {any} thread @param {string | null} [release]
 */
export function readyGroups(rt, thread, release = null) {
  const blocked = new Set();
  const groups = new Map();
  const held = (/** @type {string} */ id) => id !== release && heldAfterFailure(rt, id);
  for (const q of thread.queue ?? []) {
    // An agent being deleted gets nothing in its Undo window: its messages wait for Undo or the purge (#427, R1).
    const free = !q.sessionIds.some((id) => blocked.has(id) || rt.turns.has(id) || rt.exiting.has(id) || rt.s.sessions[id]?.deleting || held(id));
    if (!free) {
      for (const id of q.sessionIds) blocked.add(id);
      continue;
    }
    for (const id of q.sessionIds) {
      if (!groups.has(id)) groups.set(id, { sessionIds: [id], entries: [] });
      groups.get(id).entries.push(q);
    }
  }
  return [...groups.values()];
}

/** A turn’s later streaming segments are the same post, not a new instruction from its author. */
export function latestMessage(rt, threadId, message) {
  if (message.kind !== 'agent') return message;
  const from = String(message.from ?? '')
    .replace(/^@/, '')
    .toLowerCase();
  const items = rt.store.items(threadId);
  const index = positionOf(items, message.itemId);
  const source = items[index];
  const turnId = source?.fromTurnId ?? source?.turnId;
  const latest = items.slice(index + 1).findLast((item) => {
    if (item.kind !== 'agent' || String(item.handle ?? '').toLowerCase() !== from || !String(item.text ?? '').trim()) return false;
    if (index < 0 && !(item.at > message.at)) return false;
    return !turnId || turnId !== (item.fromTurnId ?? item.turnId);
  });
  return latest ? { ...message, text: latest.text, itemId: latest.id, at: latest.at } : message;
}

// When each message waiting for an agent arrived, as a count (#733): `at` is a clock reading, and two messages can land
// in the same millisecond, so the order they’re given in breaks a tie by this, not by where each sat. In memory only:
// across a restart the clock has moved on, so a tie can’t span one.
let arrivals = 0;
/** The next arrival’s number. */
export const arrival = () => ++arrivals;
/** Earlier first: by the clock, then by arrival. @param {{ at?: number, seq?: number }} a @param {{ at?: number, seq?: number }} b */
export const byArrival = (a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);

export const plainMessage = (message) => ['user', 'agent'].includes(message.kind) && !message.slash && !message.messages;

/** @param {any[]} messages */
export function combineMessages(messages) {
  const seen = new Set();
  const all = messages
    .flatMap((message) => message.messages ?? [message])
    .reverse()
    .filter((message) => {
      if (message.kind !== 'agent' || !message.itemId) return true;
      if (seen.has(message.itemId)) return false;
      seen.add(message.itemId);
      return true;
    })
    .reverse()
    .sort(byArrival);
  if (all.length === 1) return all[0];
  const last = all.at(-1);
  return {
    kind: all.some((message) => message.kind === 'user') ? 'user' : 'agent',
    from: last.from,
    text: all.map((message) => message.text ?? '').join('\n\n'),
    itemId: last.itemId,
    messages: all,
  };
}
