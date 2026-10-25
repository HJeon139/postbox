// bring_to_conversation (#128): an agent in a side or topic thread posts in the main conversation, when the person
// asked it to there. Moved from server/side-threads.mjs; functions take the Runtime first (architecture.md, “What a
// move may change”).

import { tooLongToSend } from './helpers.mjs';

/**
 * Whether a turn may use bring_to_conversation (#128): one the person started, with a message in a side or topic
 * thread. A turn another agent started can’t, so nothing reaches the conversation unless the person asked for it.
 * @param {any} rt @param {any} turn
 */
export function offersBring(rt, turn) {
  return turn?.kind === 'user' && ['side', 'topic'].includes(rt.s.threads[turn.threadId]?.kind);
}

/**
 * bring_to_conversation { text } (#128): an agent in a side or topic thread, asked by the person to put something in the
 * main chat, posts it in the conversation, marked as shared by that agent from that thread. It wakes no one, so it
 * doesn’t count against the wake limit, and under principle 7 the person who asked is the one sending it.
 * @param {any} rt @param {string} sessionId @param {any} turn  the turn calling it @param {{ text?: unknown }} [args]
 */
export function bringToConversation(rt, sessionId, turn, { text } = {}) {
  const t = rt.s.threads[turn?.threadId];
  if (t?.kind !== 'side' && t?.kind !== 'topic')
    return { ok: false, message: 'bring_to_conversation works only in a side thread or a topic thread. Here you’re in the conversation: just reply.' };
  if (!offersBring(rt, turn))
    return { ok: false, message: 'Only the person can ask for this: a turn another agent started can’t post to the conversation. Reply in the thread.' };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, message: 'Give the text to post in the conversation.' };
  const over = tooLongToSend('A post to the conversation', body);
  if (over) return over;
  // The main chat, as the person asked and the tool says: the conversation itself, from a side thread of a topic too.
  let main = rt.s.threads[t.parentId];
  while (main && (main.kind === 'side' || main.kind === 'topic')) main = rt.s.threads[main.parentId];
  const se = rt.session(sessionId);
  rt.shareText(main.id, { fromThreadId: t.id, handle: se.handle, text: body, agent: true });
  return { ok: true, message: `Posted in “${main.title}”. Its agents read it at their next turn; no one was woken.` };
}
