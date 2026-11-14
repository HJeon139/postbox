// Topic and side threads in what agents read (#228). With no forks, a conversation’s agents answer in its threads from
// their one session, so a turn there catches up on the thread; and the conversation’s other agents see each thread with
// something new, as a line they choose whether to read, with its summary (thread-summary.mjs). Moved out of
// thread-summary.mjs.

import { positionOf } from '../shared/item-index.mjs';
import { READING } from '../shared/limits.mjs';
import { keepFor, leftOut, mentions } from './catch-up-keep.mjs';
import { clipText } from './helpers.mjs';
import { lineOf, SAID } from './thread-summary.mjs';

export function firstPromptSection(message, inThread) {
  if (typeof message.attach === 'string') return 'attach';
  if (message.slash === true) return 'slash';
  const direct = message.kind === 'user' || message.kind === 'agent' || message.kind === 'event';
  return inThread && direct ? (message.taskContext ? 'thread-task' : 'missing') : inThread ? 'system' : 'room';
}

export function turnContext(rt, se, where, message, slash) {
  if (slash) return message;
  // Every message the turn delivers, each of a batch, is read in full there, so no summary gives it again (#506).
  const given = (message.messages ?? [message]).map((/** @type {any} */ m) => m.itemId).filter(Boolean);
  const thread = where === se.threadId ? null : (threadCatchUp(rt, se, where, given) ?? threadHeader(rt, where));
  const room = rt.catchUp(se, given);
  const prior = [room, ...(message.context ?? [])].filter(Boolean);
  const direct = message.kind === 'user' || message.kind === 'agent' || message.kind === 'event';
  if (!thread || !direct) return prior.length || thread ? { ...message, context: [...prior, thread].filter(Boolean) } : message;
  const context = prior.length ? [`[Postbox] Meanwhile in the room and other background context (answer room work in the room):\n\n${prior.join('\n\n')}`] : [];
  return { ...message, taskContext: thread, context };
}

/** The header that makes a topic or historical side thread the place this turn must answer. */
export function threadHeader(rt, threadId) {
  const t = rt.store.pending.thread(threadId); // where the turn answers, as deliver chose it: maybe a topic just opened (#796)
  if (t?.kind !== 'topic' && t?.kind !== 'side') return null;
  const where = `${t.kind === 'topic' ? 'the thread' : 'the side thread'} “${t.title}” (thread ${t.id})`;
  return `[Postbox] You’re answering in ${where}.`;
}

/** How many of a thread's items its catch-up keeps, past the mentions of the agent: fewer than a conversation's. */
const THREAD_ITEMS = 20;

/**
 * What a turn in a topic or side thread catches up on there: the message a topic thread is on, the first time, and
 * what was said in the thread since this agent last took part in it. null when there’s nothing.
 * @param {any} rt @param {any} se @param {string} threadId  where the turn speaks @param {string[]} [exclude]  the messages it answers
 */
export function threadCatchUp(rt, se, threadId, exclude = []) {
  // The thread as deliver chose it, maybe a topic just opened, held (#796); what was said there is what was published.
  const t = rt.store.pending.thread(threadId);
  if (t?.kind !== 'topic' && t?.kind !== 'side') return null;
  const items = rt.store.items(threadId);
  const seen = se.seenIn?.[threadId];
  const at = seen ? positionOf(items, seen) : -1;
  rt.sessions.update(se.id, { seenIn: { ...(se.seenIn ?? {}), [threadId]: items.at(-1)?.id ?? null } });
  const root = seen === undefined ? rt.topicRootLine(se, t) : null;
  // The conversation's own rules (#507): a message that @-mentions the agent first and whole, then the newest, up to
  // THREAD_ITEMS and CATCH_UP_CHARS, and a line saying what was left out and how to read it in this thread.
  const entries = items
    .slice(at + 1)
    .filter((i) => !exclude.includes(i.id) && i.sessionId !== se.id)
    .map((item) => ({ item, line: rt.describeItem(item, se, mentions(item, se.handle) ? READING.mention : READING.item) }))
    .filter((e) => e.line);
  const kept = keepFor(entries, se.handle, THREAD_ITEMS);
  const left = entries.filter((e) => !kept.includes(e));
  const lines = [...kept.map((e) => e.line), ...reactionLines(rt, se, threadId)];
  if (!root && !lines.length) return null;
  const header = threadHeader(rt, threadId);
  const since = `What was said there since you last took part${left.length ? ` ${leftOut(kept, left, items, se.handle, threadId)}` : ''}:`;
  return `${header}${root ? ` ${root}` : ''}${lines.length ? `\n\n${since}\n\n${lines.join('\n\n')}` : ''}`;
}

/**
 * For another agent’s catch-up: the conversation’s topic and side threads with something new since `since`, one line
 * each, with the summary when there is one, once per new message there. Left out: a side thread whose link is itself
 * new (its link says it), one where this agent spoke last, and one it has read up to, such as the one it answers in.
 * @param {any} rt @param {any} se @param {number} since
 * @returns {string[]}
 */
export function threadLines(rt, se, since) {
  const now = rt.s.sessions[se.id] ?? se;
  const told = { ...(now.threadsTold ?? {}) };
  const out = Object.values(rt.s.threads)
    .filter((t) => (t.kind === 'topic' || t.kind === 'side') && t.parentId === se.threadId)
    .map((t) => ({ t, line: lineOf(rt, t), last: rt.store.items(t.id).findLast(SAID) }))
    .filter(({ t, line, last }) => line && last && last.at > since && last.sessionId !== se.id && !(t.kind === 'side' && line.at > since))
    .filter(({ t, last }) => told[t.id] !== last.id && !readUpTo(rt, now, t.id, last));
  for (const { t, last } of out) told[t.id] = last.id;
  if (out.length) rt.sessions.update(se.id, { threadsTold: told });
  return out.map(({ t, line }) => describeThread(t, line));
}

/** Whether a session’s catch-up in a thread (threadCatchUp) has reached an item of it. */
function readUpTo(rt, se, threadId, item) {
  const items = rt.store.items(threadId);
  const seen = se.seenIn?.[threadId];
  return !!seen && items.findIndex((i) => i.id === seen) >= items.indexOf(item);
}

/** A thread as one line: what it is, how much is in it, its summary, and how to read it. */
export function describeThread(t, line) {
  const n = (t.kind === 'side' ? line.count : line.replies) ?? 0;
  const what = t.kind === 'side' ? `The side thread “${t.title}”` : `The thread “${t.title}”`;
  const summary = line.threadSummary ? `; in short, as a model summarized it: “${line.threadSummary}”` : '';
  return `${what} has new messages (${n} in all${summary}; read_conversation with thread: "${t.id}" reads it).`;
}

// ── Reactions (#251) ────────────────────────────────────────────────────────────────────────────────────

/** Who an item is from, as a catch-up names them. */
const whose = (it) =>
  it.kind === 'user'
    ? 'their own message'
    : it.handle
      ? `@${it.handle}’s ${it.kind === 'block' ? (it.block?.type === 'app' ? 'app' : 'block') : 'message'}`
      : 'a message';

/**
 * The reactions in one thread that this agent hasn’t been told of, as catch-up lines, oldest first; each is told once.
 * The person’s are heard by the agents answering in that thread (principle 7): the conversation’s in its catch-up, a
 * topic or side thread’s in threadCatchUp. One on the agent’s own message says so. An agent’s reaction is heard only by
 * the agent whose message it is, and not when it reacted to its own.
 * @param {any} rt @param {any} se  the agent @param {string} threadId
 * @returns {string[]}
 */
export function reactionLines(rt, se, threadId) {
  const now = rt.s.sessions[se.id] ?? se;
  // What was told last: the newest reaction’s time, and which reactions had it, so one made in the same millisecond
  // is still told, once.
  const was = now.reactionsTold?.[threadId] ?? { at: se.startedAt ?? 0, keys: [] };
  const key = (it, r) => `${it.id} ${r.emoji}${r.by ? ` ${r.by}` : ''}`;
  const hears = (it, r) => !r.by || (it.sessionId === se.id && r.by !== se.id);
  const told = rt.store
    .items(threadId)
    .flatMap((it) =>
      (it.reactions ?? []).filter((r) => hears(it, r) && (r.at > was.at || (r.at === was.at && !was.keys.includes(key(it, r))))).map((r) => ({ it, r })),
    )
    .sort((a, b) => a.r.at - b.r.at);
  if (!told.length) return [];
  const at = told.at(-1).r.at;
  const keys = [...(at === was.at ? was.keys : []), ...told.filter((x) => x.r.at === at).map((x) => key(x.it, x.r))];
  rt.sessions.update(se.id, { reactionsTold: { ...(now.reactionsTold ?? {}), [threadId]: { at, keys } } });
  return told.map(({ it, r }) => {
    const when = new Date(r.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const words = clipText(
      String(it.kind === 'block' ? (it.block?.title ?? it.block?.fallback ?? '') : (it.text ?? ''))
        .replace(/\s+/g, ' ')
        .trim(),
      80,
    );
    // The person is named, as in a catch-up’s “The person: …”; the agent’s own message is marked as its own.
    const mine = it.sessionId && it.sessionId === se.id ? ' (yours: take it as feedback)' : '';
    // An agent’s reaction is to this agent’s own message, and is feedback from a teammate.
    if (r.by) return `@${r.handle} reacted ${r.emoji} to your ${it.kind === 'block' ? 'block' : 'message'} at ${when}${words ? `: “${words}”` : ''}`;
    return `The person reacted ${r.emoji} to ${whose(it)}${mine} at ${when}${words ? `: “${words}”` : ''}`;
  });
}
