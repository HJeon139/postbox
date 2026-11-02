// Topic threads (#228, #637): a topic opens from one message of a conversation, from the page or from an agent's
// open_topic. Moved from server/runtime.mjs, whose Runtime keeps a method that delegates to it.

import { clip, httpError } from './helpers.mjs';
import { newId } from './store.mjs';

/**
 * Opens the topic thread of one message, or returns the one it has: `created` says which. It reads the message and its
 * topic through store.pending, since its result decides a write: a second open while the first is held behind a commit
 * finds that topic, so a message has one topic (#601, #637).
 * @param {import('./runtime.mjs').Runtime} rt @param {string} threadId @param {string} itemId
 * @returns {{ threadId: string, created: boolean }}
 */
export function startTopic(rt, threadId, itemId) {
  const parent = rt.thread(threadId);
  if (parent.kind === 'topic' || parent.kind === 'side') throw httpError(409, 'A topic thread can’t start another one. Reply in this one instead.');
  const items = rt.store.pending.items(threadId);
  const idx = items.findIndex((x) => x.id === itemId);
  const root = items[idx];
  if (!root || !['user', 'agent', 'block', 'shared'].includes(root.kind)) throw httpError(404, 'That message can’t start a thread.');
  if (root.topicId && rt.store.pending.thread(root.topicId)) return { threadId: root.topicId, created: false };
  const topic = rt.putThread({
    id: newId('th'),
    projectId: parent.projectId,
    // Named after the message’s first line, which is its heading when it has one.
    title: clip((root.text ?? '').split('\n').find((l) => l.trim()) || root.block?.title || root.block?.fallback || 'Thread', 60),
    kind: 'topic',
    parentId: threadId,
    rootItemId: itemId,
    // Who answers in it before anyone has spoken there (sendMessage): set below.
    woke: null,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
    archived: false,
  });
  rt.patchItem(threadId, itemId, { topicId: topic.id, replies: 0 });
  // Who comes along: the agent that wrote the message, or for yours, the agent that answered it.
  const answer = items.slice(idx + 1).find((x) => x.sessionId && (x.kind === 'agent' || x.kind === 'block'));
  const members = rt.sessionsIn(threadId).filter((x) => !x.archived);
  const src =
    (root.sessionId && rt.s.sessions[root.sessionId]) ||
    (answer && rt.s.sessions[answer.sessionId]) ||
    members.find((x) => x.id === parent.lastSpeaker) ||
    members[0];
  if (src) rt.putThread({ ...topic, woke: src.handle });
  return { threadId: topic.id, created: true };
}
