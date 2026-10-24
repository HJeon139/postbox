// Sharing from a topic or side thread into its conversation (#128): Send to conversation, and what Summarize back and
// bring_to_conversation post. A reply keeps the question it answers (#111). Functions take the Runtime first, as
// server/side-threads.mjs’s do.

import { httpError } from './helpers.mjs';

/**
 * “Send to conversation”: share a message from a topic or side thread, with its question when it is an agent reply.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} topicId @param {string} itemId
 */
export function shareTopicReply(rt, topicId, itemId) {
  const topic = rt.thread(topicId);
  if (topic.kind !== 'topic' && topic.kind !== 'side') throw httpError(409, 'Only messages in a topic or side thread can be sent to the conversation.');
  const it = rt.store.item(topicId, itemId);
  if (!it?.text) throw httpError(404, 'That reply has no text to send.');
  if (it.sharedAt) throw httpError(409, 'That reply is already in the conversation.');
  // Part of a summary still being written: the whole summary is posted when it’s done (#93).
  if ([...rt.turns.values()].some((x) => x.id === it.turnId && x.summarizeTo))
    throw httpError(409, 'This reply is part of a summary that’s still being written. It’s posted in the conversation when it’s done.');
  const items = topic.kind === 'topic' && it.kind === 'agent' ? rt.store.items(topicId) : [];
  const index = items.findIndex((item) => item.id === it.id);
  const question = index >= 0 ? items.slice(0, index).findLast((item) => item.kind === 'user')?.text : undefined;
  rt.patchItem(topicId, itemId, { sharedAt: Date.now() });
  return rt.shareText(topic.parentId, { fromThreadId: topicId, handle: it.kind === 'user' ? null : it.handle, text: it.text, question });
}

/**
 * Post thread text in its conversation for the next agent turn, without waking anyone (#128).
 * @param {import('./runtime.mjs').Runtime} rt @param {string} threadId
 * @param {{ fromThreadId: string, handle?: string | null, text: string, summary?: boolean, agent?: boolean, question?: string }} item
 */
export function shareThreadText(rt, threadId, { fromThreadId, handle, text, summary = false, agent = false, question = undefined }) {
  const from = rt.s.threads[fromThreadId];
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
