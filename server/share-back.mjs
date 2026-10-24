// What comes back from a topic or side thread to its conversation (#93, #128): Send to conversation on a message, and
// Summarize back, which asks the thread’s agent for a summary and posts it there. The conversation’s agents read it
// at their next turn; nothing wakes them. Functions take the Runtime first (architecture.md, “What a move may change”).

import { clip, httpError } from './helpers.mjs';
import { threadPersona } from './side-threads.mjs';

/** “Send to conversation”: a message from a topic or side thread (#128) is posted in its conversation, for you and its agents. */
export function shareToConversation(rt, topicId, itemId) {
  const topic = rt.thread(topicId);
  if (topic.kind !== 'topic' && topic.kind !== 'side') throw httpError(409, 'Only messages in a topic or side thread can be sent to the conversation.');
  const it = rt.store.item(topicId, itemId);
  if (!it?.text) throw httpError(404, 'That reply has no text to send.');
  if (it.sharedAt) throw httpError(409, 'That reply is already in the conversation.');
  // Part of a summary still being written: the whole summary is posted when it’s done (#93).
  if ([...rt.turns.values()].some((x) => x.id === it.turnId && x.summarizeTo))
    throw httpError(409, 'This reply is part of a summary that’s still being written. It’s posted in the conversation when it’s done.');
  // A topic's reply keeps the question it answers (#111): the person's last message before it.
  const items = topic.kind === 'topic' && it.kind === 'agent' ? rt.store.items(topicId) : [];
  const index = items.findIndex((item) => item.id === it.id);
  const question = index >= 0 ? items.slice(0, index).findLast((item) => item.kind === 'user')?.text : undefined;
  rt.patchItem(topicId, itemId, { sharedAt: Date.now() });
  return rt.shareText(topic.parentId, { fromThreadId: topicId, handle: it.kind === 'user' ? null : it.handle, text: it.text, question });
}

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
  // Kept on the thread for the panel’s button, until the turn ends or is stopped. A restart can leave it
  // behind an idle agent, which the panel treats as done; the check above looks at the turns themselves.
  rt.putThread({ ...topic, summaryPending: { sessionId: se.id, at: Date.now() } });
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
 * The thread’s summary isn’t pending any more, unless one is still running or queued. ended: a turn that just ended,
 * whose summary queued behind it starts next (takePending), so it stays pending through the handoff.
 * @param {any} rt @param {string} topicId @param {any} [ended]
 */
export function clearSummaryPending(rt, topicId, ended = null) {
  const t = rt.s.threads[topicId];
  const next = ended?.pending.some((p) => p.summarizeTo && p.threadId === topicId);
  if (t?.summaryPending && !next && !rt.summarizing(topicId)) rt.putThread({ ...t, summaryPending: null });
}

/**
 * Posts text from a topic or side thread in its conversation. The conversation’s agents read it at the start of
 * their next turn rather than being woken by it, so sharing never costs a turn. agent: the agent posted it with
 * bring_to_conversation, because the person asked it to (#128).
 */
export function shareText(rt, threadId, { fromThreadId, handle, text, summary = false, agent = false, question = undefined }) {
  const from = rt.s.threads[fromThreadId];
  // The conversation’s agents read it at the start of their next turn, with everything else they missed.
  return rt.addItem(threadId, {
    kind: 'shared',
    fromThreadId,
    fromTitle: from?.title ?? '',
    handle,
    text,
    summary,
    ...(agent ? { agent } : {}),
    ...(question === undefined ? {} : { question }),
  });
}
