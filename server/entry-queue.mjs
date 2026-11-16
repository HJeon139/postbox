// The person’s Remove and Send now on an agent’s waiting message (#228, #374), which is an entry in that agent’s inbox
// since mentions became entries (designs/rooms-at-scale.md, “Delivery”). The page lists those entries in the agent’s
// queue beside the person’s own queued messages, and the queue’s routes reach here for an entry’s id: only one waiting
// in the inbox of a session of the route’s own conversation. Functions take the Runtime first, as waiting code does
// until Turns is a service.

import { messageOf } from './entry-turns.mjs';
import { clip, httpError } from './helpers.mjs';
import { stopForSendNow } from './message-queue.mjs';
import { newId } from './store.mjs';

/** Whether a queue route’s id names an inbox entry rather than a queued message. @param {string} id */
export const isEntryId = (id) => String(id).startsWith('en_');

/** An agent’s message isn’t the person’s to edit, as a queued wake wasn’t. */
export function refuseEntryEdit() {
  throw httpError(409, 'An agent’s message can’t be edited. Remove it instead.');
}

/**
 * The session in the thread’s conversation whose inbox holds the entry waiting, or a 404 as for a queued message that
 * already went: an entry of another conversation is never found from this one.
 * @param {any} rt @param {string} threadId @param {string} entryId
 */
function holderOf(rt, threadId, entryId) {
  const conv = rt.threads.lineage(rt.threads.toWrite(threadId).id).at(-1);
  const se = rt.sessions.in(conv).find((/** @type {any} */ x) => rt.delivery.waiting(x.id).some((e) => e.id === entryId));
  if (!se) throw httpError(404, 'That queued message was already sent or removed.');
  return se;
}

/**
 * Remove: the entry is stopped, so it starts no turn, and the agent that sent it hears it won’t be answered, as it did
 * for a queued wake (#228).
 * @param {any} rt @param {string} threadId @param {string} entryId
 */
export function cancelEntry(rt, threadId, entryId) {
  const e = rt.delivery.cancel(holderOf(rt, threadId, entryId).id, entryId);
  if (!e?.from) return;
  const sender = rt.sessions.in(rt.threads.lineage(e.threadId).at(-1)).find((/** @type {any} */ x) => x.handle === e.from);
  const said = clip(rt.store.pending.item(e.threadId, e.itemId)?.text ?? '', 120);
  if (sender && !sender.retiredFork) rt.sessions.tell(sender.id, `The person removed your message (“${said}”) before it was answered. Carry on without it.`);
}

/**
 * Send now: the agent’s turn stops as for the person’s own Send now (stopForSendNow), and a turn takes this entry
 * alone. The agent’s other waiting entries go in the turn after it.
 * @param {any} rt @param {string} threadId @param {string} entryId
 */
export function sendEntryNow(rt, threadId, entryId) {
  const se = holderOf(rt, threadId, entryId);
  stopForSendNow(rt, se.id);
  const turnId = newId('turn');
  const e = rt.delivery.takeOne(se.id, entryId, turnId);
  if (!e) throw httpError(404, 'That queued message was already sent or removed.');
  rt.deliver(se.id, { ...messageOf(rt, e), turnId, fromEntries: true, entriesWait: true }, { threadId: e.threadId });
  return { ok: true };
}
