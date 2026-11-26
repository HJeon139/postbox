// A message you send (#110, #121, #228): who it goes to (the agents you @-mention, joined if they weren’t here, else
// the one you reply to), whether it waits in the queue for a busy agent or goes now, and the threads it links to,
// which its agents are told how to read. It’s posted when it’s sent, and each agent it goes to gets an inbox entry. Moved out of
// server/runtime.mjs; Runtime keeps a method of each name that delegates here.

import { parseMentions } from '../shared/text.mjs';
import { cutText } from '../shared/text-parts.mjs';
import { httpError, retiredError } from './helpers.mjs';
import * as queue from './message-queue.mjs';
import { refuseWhileHeld } from './run-clock-held.mjs';
import { sideSession, threadPersona } from './side-threads.mjs';
import { retireStale } from './wake-cards.mjs';

/**
 * You send a message: @mentions wake agents (joining them to the thread); otherwise the last speaker replies.
 * `clientId`: the id the page’s outbox gives the message, which it sends again when the response to a try was lost. A
 * repeat is answered with what the first try posted, and stores nothing (#1138).
 * @param {any} rt @param {string} threadId
 * @param {{ text?: string, attachments?: any[], sendNow?: boolean, clientId?: unknown }} [message]  as the route has it
 * @param {{ id: string, keep?: () => void }} [sender]  who sent it (#1742), as the server knows from who is asking, never
 *   read from the message: their id, and what keeps them as someone this Postbox knows (server/identity/session.mjs)
 */
export function sendMessage(rt, threadId, { text = '', attachments = [], sendNow = false, clientId = undefined } = {}, sender = undefined) {
  // As written: a conversation just started behind a held commit isn’t published yet, and its first message is sent (#1292).
  const t = rt.threads.toWrite(threadId);
  // First, before whom it goes to is worked out again: with no @-mention that’s the last speaker, who may have changed
  // since the first try (#1418’s review).
  const retryId = typeof clientId === 'string' && clientId ? clientId.slice(0, 100) : undefined;
  const repeat = retryId && repeatOf(rt, threadId, retryId);
  if (repeat) return repeat;
  text = cutText(String(text), 50000);
  attachments = rt.assets.sentAttachments(attachments);
  if (!text.trim() && !attachments.length) throw httpError(400, 'Write a message or attach a file first.');
  const mentioned = parseMentions(text, rt.personas.handles())
    .map((h) => rt.personas.byHandle(h))
    .filter(Boolean);
  // A side or topic thread is answered by the conversation’s own sessions (#110, #128, #228): an agent you
  // @-mention there, or the one you reply to, answers from its one session in the conversation, and the reply shows here.
  // Side threads from before #372 are history: agents talk in the conversation now.
  if (t.kind === 'side') throw httpError(409, 'Side threads are read-only now. Write in the conversation, where the agents talk.');
  // Refuse before anything is posted or joined: a turn for an agent whose backend isn’t registered couldn’t start (#874).
  rt.placement.refuseUnregisteredSend(mentioned);
  const targets = targetsOf(rt, t, mentioned);
  // With run clocks on: Send now would start a turn a clock holds, which it would only hold (#1526).
  if (sendNow && rt.runClock) for (const { se } of targets) refuseWhileHeld(rt, se.id, 'send-now');
  // Send now is a change of course (stopForSendNow), also for one already exiting from a plain Stop (#1040).
  if (sendNow) for (const { se } of targets) queue.stopForSendNow(rt, se.id);
  // Posted when it’s sent, with one entry per agent it goes to (designs/rooms-at-scale.md, “What an entry is”): a busy
  // agent’s waits in its inbox, which its queue lists, and an idle one’s starts its turn (#1404).
  // The sender is kept now: nothing can refuse the send any more, and the turn it starts is worded as it posts, which
  // names a sender only if Postbox knows them.
  sender?.keep?.();
  const { item } = queue.postUserMessage(
    rt,
    threadId,
    { text, attachments },
    targets.map(({ se }) => se.handle),
    sender ? { personId: sender.id } : {},
  );
  const entries = targets.map(({ se }) =>
    rt.delivery.send({ sessionId: se.id, threadId, source: 'person', itemId: item.id, from: 'you', retryId }, { wake: false }),
  );
  // Send now goes alone: a turn takes its entry ahead of the rest, which wait for the turn after it.
  for (const e of entries) {
    if (sendNow) rt.turnService.takeAlone(e);
    else rt.delivery.wake(e.sessionId);
  }
  const queued = entries.filter((e) => rt.delivery.waiting(e.sessionId).some((x) => x.id === e.id));
  // A card waiting to wake one of them is stale now (#439), whether this went at once or waits in the inbox. It
  // retires after, so the wake you never allowed goes behind your message rather than ahead of it.
  for (const { se } of targets) retireStale(rt, threadId, se, 'you wrote to it', { byPerson: true });
  return queued.length ? { item, queued } : { item };
}

/**
 * A try of a message the page already sent (#1138): the item its first try posted, found by the retry id its entries
 * carry, whatever became of them since, in the inbox of any agent of the conversation.
 * @param {any} rt @param {string} threadId @param {string} retryId
 */
function repeatOf(rt, threadId, retryId) {
  // The conversation as written: a retry of a first message sent behind a held commit is found, not posted twice (#1292).
  for (const se of rt.sessions.pendingIn(rt.threads.lineage(threadId, (id) => rt.store.pending.thread(id)).at(-1))) {
    const e = rt.delivery.inbox(se.id).find((/** @type {any} */ x) => x.retryId === retryId);
    if (e) return { item: rt.store.pending.item(e.threadId, e.itemId) };
  }
  return null;
}

/**
 * The threads a message of yours links to (#121), as Copy link or the composer’s # gives them, each with its id and
 * title so the agent can read it. Only threads of the same conversation: read_conversation reads no others.
 * @param {string} threadId @param {string} text
 */
export function threadRefs(rt, threadId, text) {
  const root = (x) => rt.threads.lineage(x).at(-1);
  const ids = new Set();
  for (const m of String(text).matchAll(/#\/t\/(th_[A-Za-z0-9]+)(?:\/side\/(th_[A-Za-z0-9]+))?/g)) ids.add(m[2] ?? m[1]);
  const out = [];
  for (const id of [...ids].slice(0, 10)) {
    const t = rt.s.threads[id];
    if (!t || id === threadId || root(id) !== root(threadId)) continue;
    const what = t.kind === 'side' ? 'side thread' : t.kind === 'topic' ? 'topic thread' : 'conversation';
    out.push(`[Postbox] The person’s message links to the ${what} “${t.title}” (thread ${id}). Read it with read_conversation with thread: "${id}".`);
  }
  return out;
}

/**
 * Who a message of yours goes to: in a topic thread, the agents you @-mention, else the agent it answers with, from
 * their one session in the conversation; elsewhere, the agents you @-mention, joined if they weren’t here, else the
 * last speaker. Refuses before anything is posted: a retired fork of an agent you mention, no agent at all, or an agent whose
 * backend isn’t registered here.
 * @param {any} rt @param {any} t  the thread @param {any[]} mentioned  the personas you @-mentioned
 * @returns {{ se: any }[]}
 */
function targetsOf(rt, t, mentioned) {
  const threadId = t.id;
  const targets = [];
  const away = t.kind === 'topic';
  if (away) {
    for (const p of mentioned) targets.push({ se: sideSession(rt, t, p.id, 'you') });
    if (!targets.length) {
      // The last speaker’s agent replies, as in a conversation; before anyone has, the agent it started with.
      const p = threadPersona(rt, t);
      // Refused before sideSession, which would join an agent not yet in the conversation (#874).
      if (p) rt.placement.refuseUnregisteredSend([p]);
      const se = p && sideSession(rt, t, p.id, 'you');
      if (!se) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
      targets.push({ se });
    }
  }
  // Refuse before anything is posted, so a refused message doesn’t also appear in the transcript.
  const retired = mentioned.map((p) => rt.sessions.pendingIn(threadId).find((x) => x.personaId === p.id)).find((x) => x?.retiredFork);
  if (retired && !away) throw retiredError(retired);
  for (const p of away ? [] : mentioned) {
    const joined = !rt.sessions.pendingIn(threadId).some((x) => x.personaId === p.id);
    targets.push({ se: rt.ensureSession(threadId, p.id, { brief: joined ? 'You were @-mentioned into this thread.' : null }) });
  }
  if (!targets.length) {
    const members = rt.sessions.pendingIn(threadId).filter((x) => !x.retiredFork);
    const last = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
    if (!last) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
    targets.push({ se: last });
  }
  // And the agent you reply to, as the mentioned ones above.
  const woken = targets.map(({ se }) => rt.persona(se.personaId));
  rt.placement.refuseUnregisteredSend(woken);
  return targets;
}
