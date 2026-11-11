// A message you send (#110, #121, #228): who it goes to (the agents you @-mention, joined if they weren’t here, else
// the one you reply to), whether it waits in the queue for a busy agent or goes now, and the threads it links to,
// which its agents are told how to read. Delivery and the queue are message-queue.mjs’s. Moved out of
// server/runtime.mjs; Runtime keeps a method of each name that delegates here.

import { parseMentions } from '../shared/text.mjs';
import { httpError } from './helpers.mjs';
import { sentAttachments } from './message-attachments.mjs';
import * as queue from './message-queue.mjs';
import { arrival } from './queue-batch.mjs';
import { refuseUnregisteredSend } from './remote/placement.mjs';
import { threadPersona } from './side-threads.mjs';
import { newId } from './store.mjs';
import { updateThread } from './thread-write.mjs';
import { retireStale } from './wake-cards.mjs';

/** You send a message: @mentions wake agents (joining them to the thread); otherwise the last speaker replies. */
export function sendMessage(rt, threadId, { text = '', attachments = [], sendNow = false } = {}) {
  const t = rt.thread(threadId);
  text = String(text).slice(0, 50000);
  attachments = sentAttachments(rt, attachments);
  if (!text.trim() && !attachments.length) throw httpError(400, 'Write a message or attach a file first.');
  const mentioned = parseMentions(text, rt.handles())
    .map((h) => rt.personaByHandle(h))
    .filter(Boolean);
  // A side or topic thread is answered by the conversation’s own sessions (#110, #128, #228): an agent you
  // @-mention there, or the one you reply to, answers from its one session in the conversation, and the reply shows here.
  // Side threads from before #372 are history: agents talk in the conversation now.
  if (t.kind === 'side') throw httpError(409, 'Side threads are read-only now. Write in the conversation, where the agents talk.');
  // Refuse before anything is posted or joined: a turn for an agent whose backend isn’t registered couldn’t start (#874).
  refuseUnregisteredSend(rt, mentioned);
  const targets = targetsOf(rt, t, mentioned);
  // Messages to a busy agent wait in the queue unless you choose Send now, as for one whose host turn waits to be
  // attached again after a restart (#1135).
  const busy = targets.filter(({ se }) => rt.turns.has(se.id) || rt.remote.awaitsAttach(se.id));
  const q = busy.length && !sendNow ? { id: newId('q'), text, attachments, sessionIds: targets.map(({ se }) => se.id), at: Date.now(), seq: arrival() } : null;
  if (q) updateThread(rt, threadId, (x) => ({ queue: [...(x.queue ?? []), q] }));
  // Send now is a change of course (stopForSendNow), also for one already exiting from a plain Stop (#1040).
  else if (sendNow) for (const { se } of targets) queue.stopForSendNow(rt, se.id);
  const sent = q ? { queued: q } : rt.postAndDeliver(threadId, { text, attachments }, targets);
  // A card waiting to wake one of them is stale now (#439), whether this went at once or waits in the queue. It
  // retires after, so the wake you never allowed goes behind your message rather than ahead of it.
  for (const { se } of targets) retireStale(rt, threadId, se, 'you wrote to it', { byPerson: true });
  return sent;
}

/**
 * The threads a message of yours links to (#121), as Copy link or the composer’s # gives them, each with its id and
 * title so the agent can read it. Only threads of the same conversation: read_conversation reads no others.
 * @param {string} threadId @param {string} text
 */
export function threadRefs(rt, threadId, text) {
  const root = (x) => rt.lineage(x).at(-1);
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
 * last speaker. Refuses before anything is posted: an archived agent you mention, no agent at all, or an agent whose
 * backend isn’t registered here.
 * @param {any} rt @param {any} t  the thread @param {any[]} mentioned  the personas you @-mentioned
 * @returns {{ se: any }[]}
 */
function targetsOf(rt, t, mentioned) {
  const threadId = t.id;
  const targets = [];
  const away = t.kind === 'topic';
  if (away) {
    for (const p of mentioned) targets.push({ se: rt.sideSession(t, p.id, 'you') });
    if (!targets.length) {
      // The last speaker’s agent replies, as in a conversation; before anyone has, the agent it started with.
      const p = threadPersona(rt, t);
      // Refused before sideSession, which would join an agent not yet in the conversation (#874).
      if (p) refuseUnregisteredSend(rt, [p]);
      const se = p && rt.sideSession(t, p.id, 'you');
      if (!se) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
      targets.push({ se });
    }
  }
  // Refuse before anything is posted, so a refused message doesn’t also appear in the transcript.
  const archived = mentioned.map((p) => rt.sessionsIn(threadId).find((x) => x.personaId === p.id)).find((x) => x?.archived);
  if (archived && !away) throw httpError(409, `@${archived.handle}’s session is archived. Restore it first.`);
  for (const p of away ? [] : mentioned) {
    const joined = !rt.sessionsIn(threadId).some((x) => x.personaId === p.id);
    targets.push({ se: rt.ensureSession(threadId, p.id, { brief: joined ? 'You were @-mentioned into this thread.' : null }) });
  }
  if (!targets.length) {
    const members = rt.sessionsIn(threadId).filter((x) => !x.archived);
    const last = members.find((x) => x.id === t.lastSpeaker) ?? members[0];
    if (!last) throw httpError(409, 'No agent is in this thread. @-mention one to bring it in.');
    targets.push({ se: last });
  }
  // And the agent you reply to, as the mentioned ones above.
  const woken = targets.map(({ se }) => rt.persona(se.personaId));
  refuseUnregisteredSend(rt, woken);
  return targets;
}
