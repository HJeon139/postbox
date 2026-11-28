// bring_to_conversation (#128, #382): an agent in a side or topic thread posts in the main conversation: the thread’s
// outcome, or what the person asked it to post there. Moved from server/side-threads.mjs; functions take the Runtime
// first (designs/architecture/code-size.md, “What a move may change”).

import { tooLongToSend } from './helpers.mjs';

/**
 * Whether a turn may use bring_to_conversation: any turn with a message in a side or topic thread, whoever started it.
 * An agent posts a thread’s outcome without the person asking (#382, which reverses #128’s “only the person’s turn”);
 * in the conversation itself there’s nowhere to post from.
 * @param {any} rt @param {any} turn
 */
export function offersBring(rt, turn) {
  return ['side', 'topic'].includes(rt.store.pending.thread(turn?.threadId)?.kind);
}

/**
 * bring_to_conversation { text } (#128, #382): an agent in a side or topic thread posts in the conversation, the
 * thread’s outcome or what the person asked for, marked as posted by that agent from that thread. It wakes no one, so
 * it starts no turn and doesn’t count toward the chain’s cap (designs/intent.md, principle 7).
 * @param {any} rt @param {string} sessionId @param {any} turn  the turn calling it @param {{ text?: unknown }} [args]
 */
export function bringToConversation(rt, sessionId, turn, { text } = {}) {
  const t = rt.store.pending.thread(turn?.threadId);
  if (!offersBring(rt, turn))
    return { ok: false, message: 'bring_to_conversation works only in a side thread or a topic thread. Here you’re in the conversation: just reply.' };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, message: 'Give the text to post in the conversation.' };
  const over = tooLongToSend('A post to the conversation', body);
  if (over) return over;
  // The main chat, as the tool says: the conversation itself, from a side thread of a topic too, as the threads are
  // written: a topic opened behind a held commit counts (#623).
  const main = rt.store.pending.thread(rt.threads.conversationToWrite(t.id));
  if (!main || main.id === t.id) return { ok: false, message: 'This thread’s conversation is gone, so there’s nowhere to post. Reply in the thread.' };
  const se = rt.session(sessionId);
  rt.shareText(main.id, { fromThreadId: t.id, handle: se.handle, text: body, agent: true });
  return { ok: true, message: `Posted in “${main.title}”. Its agents read it at their next turn; no one was woken.` };
}
