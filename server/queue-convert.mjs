// A store written before the person’s message became an inbox entry when it’s sent (#1404) can hold messages in a
// thread’s `queue`. On start, before Delivery’s own start, each is turned into entries once (#1423), as it would have
// been if sent now (designs/rooms-at-scale.md, “What an entry is”):
// - the person’s message is posted as its item, with a `person` entry for each agent it waited for that is still here;
//   with none, it’s posted and wakes no one, as a message to a deleted agent was (#604);
// - an agent’s queued wake becomes a `mention` entry for the item it was posted as.
// A conversion that a crash cut short, before the queue was written back, finds what it already did and does the rest:
// the item keeps its queue row’s id (`fromQueue`), so it’s posted once, and each entry carries that id as its retry id,
// which Delivery’s send stores once per inbox. Functions take the Runtime first, as waiting code does until Turns is a
// service.

import { clip } from './helpers.mjs';
import { postUserMessage } from './message-queue.mjs';

/** Turns every stored queue into entries, then empties it. Delivery’s start wakes the agents. @param {any} rt */
export function convertQueues(rt) {
  for (const t of rt.threads.pending()) {
    if (!t.queue?.length) continue;
    for (const q of t.queue) convertOne(rt, t.id, q);
    rt.threads.patch(t.id, { queue: [] });
  }
}

/** One queue row as entries, with what an earlier conversion made found. @param {any} rt @param {string} threadId @param {any} q */
function convertOne(rt, threadId, q) {
  const agents = (q.sessionIds ?? []).map((/** @type {string} */ id) => rt.store.pending.session(id)).filter((/** @type {any} */ se) => se && !se.retiredFork);
  // Each keeps the time its row waited from, so it sorts with what arrived around it.
  const entry = { threadId, retryId: q.id, ...(typeof q.at === 'number' ? { at: q.at } : {}) };
  if (q.kind === 'wake') {
    const said = q.itemId ? { itemId: q.itemId } : { text: String(q.text ?? '') };
    for (const se of agents) rt.delivery.send({ ...entry, ...said, sessionId: se.id, source: 'mention', from: q.from }, { wake: false });
    if (!agents.length) notDelivered(rt, entry, q);
    return;
  }
  const to = agents.map((/** @type {any} */ se) => se.handle);
  const posted = rt.store.pending.items(threadId).findLast((/** @type {any} */ it) => it.fromQueue === q.id);
  const item = posted ?? postUserMessage(rt, threadId, { text: String(q.text ?? ''), attachments: q.attachments ?? [] }, to, { fromQueue: q.id }).item;
  for (const se of agents) rt.delivery.send({ ...entry, itemId: item.id, sessionId: se.id, source: 'person', from: 'you' }, { wake: false });
}

/**
 * A queued wake whose agent has left: its sender hears so at its next turn, as the queue’s drain told it, as a notice.
 * @param {any} rt @param {{ threadId: string, retryId: string, at?: number }} entry @param {any} q
 */
function notDelivered(rt, entry, q) {
  const sender = rt.store.pending.session(q.fromSessionId);
  if (!sender || sender.retiredFork) return;
  const text = `Your message (“${clip(String(q.text ?? ''), 120)}”) wasn’t delivered: the agent it was for was removed.`;
  rt.delivery.send({ ...entry, sessionId: sender.id, source: 'notice', text }, { wake: false });
}
