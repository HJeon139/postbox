// The person’s Edit, Remove and Send now on a message waiting for an agent (#228, #374): an entry in that agent’s inbox,
// an agent’s since mentions became entries, and the person’s own since it is one when it’s sent (#1404;
// designs/rooms-at-scale.md, “Delivery”). The page lists them in the agent’s queue, and the queue’s routes reach here for
// an entry’s id: only one waiting in the inbox of a session of the route’s own conversation. Functions take the Runtime
// first, as waiting code does until Turns is a service.

import { parseMentions } from '../shared/text.mjs';
import { messageOf } from './entry-turns.mjs';
import { clip, httpError } from './helpers.mjs';
import { stopForSendNow } from './message-queue.mjs';
import { newId } from './store.mjs';

/** Whether a queue route’s id names an inbox entry rather than a queued message. @param {string} id */
export const isEntryId = (id) => String(id).startsWith('en_');

/**
 * Edit: the person’s message is their item, posted when it was sent, so an edit changes it while it still waits for
 * every agent it went to; once one has it, it’s that agent’s to read as it was (#1404). An agent’s message isn’t the
 * person’s to edit, as a queued wake wasn’t.
 * @param {any} rt @param {string} threadId @param {string} entryId @param {string} text
 */
export function editEntry(rt, threadId, entryId, text) {
  const se = holderOf(rt, threadId, entryId);
  const e = rt.delivery.waiting(se.id).find((/** @type {any} */ x) => x.id === entryId);
  if (e.source !== 'person') throw httpError(409, 'An agent’s message can’t be edited. Remove it instead.');
  // A failed entry was handed to its agent too (#466).
  const given = rt.delivery.entriesFrom(e.itemId).find((/** @type {any} */ x) => GIVEN.has(x.state));
  if (given) {
    const who = rt.store.pending.session(given.sessionId)?.handle;
    throw httpError(409, `${who ? `@${who}` : 'An agent'} already has this message, so it can’t be edited. Send a new one instead.`);
  }
  const said = String(text ?? '').slice(0, 50000);
  if (!said.trim()) throw httpError(400, 'Write the message, or remove it instead.');
  // It went to the agents it named when it was sent, so an edit keeps the same ones.
  const now = rt.store.pending.item(e.threadId, e.itemId)?.text ?? '';
  if (named(rt, now) !== named(rt, said)) throw httpError(409, 'Remove it and send a new message to change who it’s for.');
  rt.threads.patchItem(e.threadId, e.itemId, { text: said });
}

/** An entry’s states once its agent was handed the message. */
const GIVEN = new Set(['taken', 'delivered', 'failed']);

/** The agents a message @-mentions, as one key to compare. @param {any} rt @param {string} text */
const named = (rt, text) => [...new Set(parseMentions(text, rt.personas.handles()).map((h) => h.toLowerCase()))].sort().join(' ');

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
  if (e?.source === 'person') return removedUnread(rt, e);
  if (!e?.from) return;
  const sender = rt.sessions.in(rt.threads.lineage(e.threadId).at(-1)).find((/** @type {any} */ x) => x.handle === e.from);
  const said = clip(rt.store.pending.item(e.threadId, e.itemId)?.text ?? '', 120);
  if (sender && !sender.retiredFork) rt.sessions.tell(sender.id, `The person removed your message (“${said}”) before it was answered. Carry on without it.`);
}

/**
 * The person removed their message for one agent: the item records it (`removedFor`), so that agent reads it was removed,
 * not its words, while others may still get it. Once no agent it went to has it or is still to get it, the item says it
 * was removed before it was read (#1404): it stays in the conversation, as everything said there does.
 * @param {any} rt @param {{ threadId: string, itemId: string, sessionId: string }} e
 */
function removedUnread(rt, { threadId, itemId, sessionId }) {
  const it = rt.store.pending.item(threadId, itemId);
  const removedFor = [...new Set([...(it?.removedFor ?? []), sessionId])];
  const unread = rt.delivery.entriesFrom(itemId).every((/** @type {any} */ x) => x.state === 'stopped');
  rt.threads.patchItem(threadId, itemId, { removedFor, ...(unread ? { removed: { at: Date.now() } } : {}) });
}

/**
 * Send now: the agent’s turn stops as for the person’s own Send now (stopForSendNow), and a turn takes this entry
 * alone. The agent’s other waiting entries go in the turn after it.
 * @param {any} rt @param {string} threadId @param {string} entryId
 */
export function sendEntryNow(rt, threadId, entryId) {
  const se = holderOf(rt, threadId, entryId);
  stopForSendNow(rt, se.id);
  const e = rt.delivery.waiting(se.id).find((/** @type {any} */ x) => x.id === entryId);
  if (!e || !sendEntryAlone(rt, e)) throw httpError(404, 'That queued message was already sent or removed.');
  return { ok: true };
}

/**
 * A turn takes one waiting entry alone, ahead of the agent’s other entries, which wait for the turn after it: Send now’s
 * take, once the agent’s turn is stopped. Returns whether it was still waiting to be taken.
 * @param {any} rt @param {{ id: string, sessionId: string }} entry
 */
export function sendEntryAlone(rt, { id, sessionId }) {
  const turnId = newId('turn');
  const e = rt.delivery.takeOne(sessionId, id, turnId);
  if (!e) return false;
  rt.deliver(sessionId, { ...messageOf(rt, e), turnId, fromEntries: true, entriesWait: true }, { threadId: e.threadId });
  return true;
}
