// Queued messages, their controls and delivery order; one session still runs at most one turn (#228).
import { clip, httpError, queuedIn } from './helpers.mjs';
import { deliverWake } from './side-threads.mjs';

export function postAndDeliver(rt, threadId, { text, attachments }, targets) {
  const item = rt.addItem(threadId, { kind: 'user', text, attachments });
  // You’re here: the wake limit starts again, on the conversation, where agents’ wakes count (#108, #228).
  const conv = rt.lineage(threadId).at(-1);
  rt.putThread({ ...rt.s.threads[conv], hops: 0, pairRuns: null });
  const refs = rt.threadRefs(threadId, text);
  // An agent you @-mentioned gets no “You woke” line: your message’s mention says so (#114).
  for (const { se } of targets) {
    rt.deliver(se.id, { kind: 'user', text, attachments, itemId: item.id, ...(refs.length ? { context: refs } : {}) }, { threadId });
  }
  return { item };
}

export function editQueued(rt, threadId, queueId, text) {
  const t = rt.thread(threadId);
  if (queuedIn(t, queueId).kind === 'wake') throw httpError(409, 'An agent’s message can’t be edited. Remove it instead.');
  const queue = (t.queue ?? []).map((q) => (q.id === queueId ? { ...q, text: String(text) } : q));
  rt.putThread({ ...t, queue });
}

export function cancelQueued(rt, threadId, queueId) {
  const t = rt.thread(threadId);
  const q = queuedIn(t, queueId);
  rt.putThread({ ...t, queue: (t.queue ?? []).filter((x) => x.id !== queueId) });
  // A wake you removed: its agent was told it would be answered, so it hears it won’t be (#228).
  if (q?.kind === 'wake' && rt.s.sessions[q.fromSessionId] && !rt.s.sessions[q.fromSessionId].archived)
    rt.tellAgent(q.fromSessionId, `The person removed your message (“${clip(q.text, 120)}”) before it was answered. Carry on without it.`);
}

export function sendQueuedNow(rt, threadId, queueId) {
  const t = rt.thread(threadId);
  const q = queuedIn(t, queueId);
  rt.putThread({ ...t, queue: t.queue.filter((x) => x.id !== queueId) });
  for (const id of q.sessionIds) rt.stop(id, { silent: true, jobs: 'keep', sendNow: true });
  if (q.kind === 'wake') return deliverWake(rt, threadId, q);
  return rt.postAndDeliver(
    threadId,
    q,
    q.sessionIds.map((id) => ({ se: rt.s.sessions[id] })).filter((x) => x.se && !x.se.archived),
  );
}

export function drainAll(rt) {
  for (const t of Object.values(rt.s.threads)) if (t.queue?.length && !t.deleting) rt.drainQueue(t.id);
}

export function drainQueue(rt, threadId, wakesOnly = false) {
  const t = rt.s.threads[threadId];
  if (!t?.queue?.length) return;
  const held = new Set();
  const go = [];
  for (const q of t.queue) {
    const free = !q.sessionIds.some((id) => held.has(id) || rt.turns.has(id) || rt.exiting.has(id));
    if (free && (!wakesOnly || q.kind === 'wake')) go.push(q);
    if (!wakesOnly || q.kind === 'wake') for (const id of q.sessionIds) held.add(id);
  }
  if (!go.length) return;
  rt.putThread({ ...t, queue: t.queue.filter((x) => !go.includes(x)) });
  for (const q of go) rt.sendQueued(threadId, q);
}

export function sendQueued(rt, threadId, q) {
  if (q.kind === 'wake') return deliverWake(rt, threadId, q);
  rt.postAndDeliver(
    threadId,
    q,
    q.sessionIds.map((id) => ({ se: rt.s.sessions[id] })).filter((x) => x.se && !x.se.archived),
  );
}

export function takePending(rt, se, turn, drain) {
  const next = turn.pending.shift();
  if (next) {
    rt.deliver(se.id, next.message, { summarizeTo: next.summarizeTo, threadId: next.threadId });
    const t = rt.turns.get(se.id);
    if (t) t.pending.push(...turn.pending);
  } else if (drain) rt.drainQueues(se.id, turn.threadId, drain === 'wakes');
}

export function drainQueues(rt, sessionId, threadId, wakesOnly = false) {
  const ids = new Set(wakesOnly ? [] : [threadId]);
  for (const t of Object.values(rt.s.threads)) if (t.queue?.some((q) => q.sessionIds.includes(sessionId) && (!wakesOnly || q.kind === 'wake'))) ids.add(t.id);
  for (const id of ids) rt.drainQueue(id, wakesOnly);
}
