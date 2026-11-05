// Topic threads (#228, #637): a topic opens from one message of a conversation, from the page or from an agent's
// open_topic. Moved from server/runtime.mjs, whose Runtime keeps a method that delegates to it.

import { positionOf } from '../shared/item-index.mjs';
import { clip, httpError, tooLongToSend } from './helpers.mjs';
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
  const idx = positionOf(items, itemId);
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

/**
 * open_topic (#637): an agent opens the topic thread of a message in its own conversation, or finds the one it has,
 * through startTopic, the page's own path. Its first message, if any, posts there as wake_agent's does, waking each
 * agent it names; one message serves every mention. Nothing is stored that the page's open doesn't store, so A2
 * converts it with everything else (designs/508/637-open-topic.md).
 * @param {import('./runtime.mjs').Runtime} rt @param {string} sessionId
 * @param {{ itemId?: string, message?: string, mentions?: string[] }} args
 */
export function openTopic(rt, sessionId, { itemId, message, mentions }) {
  const se = rt.session(sessionId);
  const text = String(message ?? '').trim() ? String(message) : '';
  const tooLong = text && tooLongToSend('A topic thread’s first message', text);
  if (tooLong) return tooLong;
  if (mentions !== undefined && !(Array.isArray(mentions) && mentions.every((h) => typeof h === 'string')))
    return { ok: false, message: 'mentions is a list of handles, such as ["critic"].' };
  const handles = [...new Set((mentions ?? []).map((h) => h.trim().replace(/^@/, '')).filter(Boolean))];
  if (mentions?.length && !handles.length) return { ok: false, message: 'mentions names no handle: give each as a handle, such as ["critic"].' };
  // Checked before anything opens: a mention is woken by the message, so with none there's nothing to wake them with.
  if (handles.length && !text) return { ok: false, message: 'mentions need a message: they’re woken by it, in the topic thread.' };
  let opened;
  try {
    opened = startTopic(rt, conversationOf(rt, se, String(itemId ?? '')), String(itemId ?? ''));
  } catch (e) {
    return { ok: false, message: /** @type {any} */ (e).message };
  }
  const { threadId, created } = opened;
  // The opener answers there first (I4), only when this call made the topic.
  if (created) rt.putThread({ ...rt.store.pending.thread(threadId), woke: se.handle });
  const woke = text && !repeated(rt, se, threadId, text, handles, created) ? post(rt, se, threadId, text, handles) : [];
  const where = `${created ? 'Opened a topic thread' : 'That message already has a topic thread'}, ${threadId}, beside it in the page. read_conversation { thread: "${threadId}" } reads it.`;
  return { ok: true, threadId, created, message: [where, ...woke].join(' ') };
}

/**
 * The thread a message is in, for the agent's own conversation only (I3): the conversation itself, or one of its topic
 * threads, whose item startTopic then refuses with its 409. An id from anywhere else is the conversation's, so
 * startTopic answers 404 for it. @param {any} rt @param {any} se @param {string} itemId
 */
function conversationOf(rt, se, itemId) {
  const conv = rt.lineage(se.threadId).at(-1);
  if (rt.store.pending.items(conv).some((/** @type {any} */ x) => x.id === itemId)) return conv;
  const topic = Object.values(rt.s.threads).find(
    (/** @type {any} */ t) => t.kind === 'topic' && t.parentId === conv && rt.store.pending.items(t.id).some((/** @type {any} */ x) => x.id === itemId),
  );
  return topic?.id ?? conv;
}

/** The handles an open named, in one order, as its message keeps them. @param {string[]} handles */
const named = (handles) => [...handles].sort().join(' ');

/**
 * Whether this open's message is already there (I6): the topic existed, and the opener's newest message in it is an
 * open's with the same text and the same handles, as a call run again after its kept reply was lost would leave it.
 */
function repeated(rt, se, threadId, text, handles, created) {
  if (created) return false;
  const mine = rt.store.pending.items(threadId).findLast((/** @type {any} */ x) => x.kind === 'agent' && x.sessionId === se.id);
  return Boolean(mine && mine.text === text && mine.opened === named(handles));
}

/**
 * Posts the first message in the topic as the agent's own, then wakes each agent it names from it, as a turn's later
 * mentions reuse its message (agentWake's `itemId`). Posting first means the ask is never lost when every wake is
 * refused (a self-mention, a mistyped handle), and a card keeps the message's id, so Allow wakes from it rather than
 * posting it again; the reply carries each wake's result. It keeps the handles it named (`opened`), which I6 compares;
 * A2's records carry the same as the message's addressees.
 */
function post(rt, se, threadId, text, handles) {
  const fromTurnId = rt.turns.get(se.id)?.id;
  const opened = named(handles);
  const it = rt.addItem(threadId, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done', opened, fromTurnId });
  return handles.map((h) => rt.agentWake(se.id, h, text, { replyIn: threadId, itemId: it.id, fromTurnId }).message);
}
