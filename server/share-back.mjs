// Summarize back from a topic or side thread (#93, #225): it asks an agent of the thread for a summary, and posts it in
// the conversation (server/thread-sharing.mjs, with Send to conversation). The conversation’s agents read it at their
// next turn; nothing wakes them. Functions take the Runtime first (architecture.md, “What a move may change”).

import { clip, httpError } from './helpers.mjs';
import { threadPersona } from './side-threads.mjs';

/**
 * “Summarize back” (#93, #225): an agent of a topic or side thread writes a short summary, which is posted in the
 * conversation, marked as from that thread. The person starts it, and nothing else comes back (intent.md, principle 7).
 * It wakes no one, so it doesn’t count against the wake limit: a summary’s @-mentions wake no one (endTurn), and nor
 * does its wake_agent (wakeAgent, server/side-threads.mjs).
 * @param {any} rt @param {string} topicId @param {{ handle?: unknown } | null} [opts]  handle: in a side thread, the agent to write it
 */
export function summarizeBack(rt, topicId, opts) {
  const topic = rt.thread(topicId);
  // Any JSON may come: a value that isn’t an object has no handle.
  const handle = opts?.handle ?? null;
  if (topic.kind !== 'topic' && topic.kind !== 'side') throw httpError(409, 'Only a topic or side thread can be summarized back.');
  const p = summaryWriter(rt, topic, handle);
  const se = p && rt.sideSession(topic, p.id, 'you');
  if (!se) throw httpError(409, 'No agent is in this thread to summarize it.');
  // One at a time, so a second click or a second tab can’t post it twice (#93).
  if (rt.summarizing(topicId)) throw httpError(409, 'A summary is already on its way. It’s posted in the conversation when it’s written.');
  markSummaryPending(rt, topicId, se.id);
  rt.addItem(topicId, { kind: 'voice', text: 'Asked for a summary to send back to the conversation' });
  const what = topic.kind === 'side' ? 'side thread' : 'topic thread';
  rt.deliver(
    se.id,
    {
      kind: 'notice',
      text: `Summarize this ${what} for the main conversation: what was decided, what changed, and anything still open. One short paragraph, no headings. It will be posted there as your summary.`,
    },
    { summarizeTo: topic.parentId, threadId: topicId },
  );
  return { ok: true };
}

/**
 * Who writes a thread’s summary. A topic thread’s agent: the one that spoke last there, else the one it started with
 * (#228). A side thread’s two (#225): the one the person names, else the one that started it, by waking the other.
 * @param {any} rt @param {any} t @param {unknown} handle
 */
function summaryWriter(rt, t, handle) {
  if (handle != null && typeof handle !== 'string') throw httpError(400, 'Name the agent to write the summary by its handle, such as “critic”.');
  const name = handle?.trim().replace(/^@/, '').toLowerCase();
  if (t.kind === 'topic') {
    if (name) throw httpError(400, 'A topic thread’s summary is written by its own agent: leave out the agent’s name.');
    return threadPersona(rt, t);
  }
  const pair = String(t.pair ?? '').split('|');
  const chosen = name ? pair.find((x) => x.toLowerCase() === name) : pair.find((x) => x !== t.woke);
  if (name && !chosen) throw httpError(400, `@${clip(name, 40)} isn’t in this side thread. Name ${pair.map((x) => `@${x}`).join(' or ')}.`);
  return rt.personaByHandle(chosen ?? t.woke ?? '');
}

/** Whether a summarize turn is running or queued in a topic or side thread. */
export function summarizing(rt, topicId) {
  return (
    [...rt.turns.values()].some((x) => (x.threadId === topicId && x.summarizeTo) || x.pending.some((p) => p.summarizeTo && p.threadId === topicId)) ||
    // One waiting for a stopped turn’s process to exit (#126).
    [...rt.exiting.values()].some((x) => x.held.some((h) => h.summarizeTo && h.threadId === topicId))
  );
}

/**
 * Kept on the thread for the panel’s button, which reads only this, in every tab and after a reload (#93, #225): it’s
 * cleared once the summary is posted, fails, is stopped or can’t start, and at a restart (the Runtime’s constructor).
 * @param {any} rt @param {string} topicId @param {string} sessionId  the session writing it
 */
export function markSummaryPending(rt, topicId, sessionId) {
  const t = rt.s.threads[topicId];
  if (t) rt.putThread({ ...t, summaryPending: { sessionId, at: Date.now() } });
}

/**
 * The thread’s summary isn’t pending any more, unless one is still running or queued. ended: a turn that just ended,
 * whose summary queued behind it starts next (takePending), so it stays pending through the handoff.
 * @param {any} rt @param {string} topicId @param {any} [ended]
 */
export function clearSummaryPending(rt, topicId, ended = null) {
  const t = rt.s.threads[topicId];
  const next = ended?.pending.some((p) => p.summarizeTo && p.threadId === topicId);
  if (t?.summaryPending && !next && !rt.summarizing(topicId)) rt.putThread({ ...t, summaryPending: null });
}
