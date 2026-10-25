// Queued messages, their controls and delivery order; one session still runs at most one turn (#228).
import { clip, httpError, queuedIn } from './helpers.mjs';
import { combineMessages, plainMessage, readyGroups, superseded } from './queue-batch.mjs';
import { deliverWake } from './side-threads.mjs';

export function postAndDeliver(rt, threadId, { text, attachments }, targets) {
  const { item, message } = postUserMessage(rt, threadId, { text, attachments });
  for (const { se } of targets) rt.deliver(se.id, message, { threadId });
  return { item };
}

function postUserMessage(rt, threadId, q) {
  const item = rt.addItem(threadId, { kind: 'user', text: q.text, attachments: q.attachments });
  const conv = rt.lineage(threadId).at(-1);
  rt.putThread({ ...rt.s.threads[conv], hops: 0, pairRuns: null });
  const refs = rt.threadRefs(threadId, q.text);
  const message = {
    kind: 'user',
    text: q.text,
    attachments: q.attachments,
    itemId: item.id,
    ...(q.at === undefined ? {} : { at: q.at }),
    ...(refs.length ? { context: refs } : {}),
  };
  return { item, message };
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
  const t = pruneStaleWakes(rt, threadId);
  if (!t?.queue?.length) return;
  const groups = readyGroups(rt, t, wakesOnly);
  for (const batch of takeBatches(rt, threadId, groups)) deliverBatch(rt, threadId, batch.sessionIds, batch.messages);
}

function takeBatches(rt, threadId, groups) {
  const go = new Set(groups.flatMap((group) => group.entries));
  const cache = new Map();
  const batches = groups.map((group) => ({ ...group, messages: queuedMessages(rt, threadId, group.entries, cache) }));
  rt.putThread({ ...rt.s.threads[threadId], queue: rt.s.threads[threadId].queue.filter((q) => !go.has(q)) });
  return batches;
}

function pruneStaleWakes(rt, threadId) {
  const t = rt.s.threads[threadId];
  if (!t?.queue?.length) return t;
  const stale = t.queue.filter(
    (q) =>
      q.kind === 'wake' &&
      q.sessionIds.every((id) => {
        const se = rt.s.sessions[id];
        return se && !se.archived && !se.deleting && !rt.turns.has(id) && !rt.exiting.has(id);
      }) &&
      superseded(rt, threadId, { kind: 'agent', from: `@${q.from}`, itemId: q.itemId, at: q.at }),
  );
  if (stale.length) rt.putThread({ ...t, queue: t.queue.filter((q) => !stale.includes(q)) });
  return rt.s.threads[threadId];
}

function queuedMessages(rt, threadId, entries, cache = new Map()) {
  return entries.flatMap((q) => {
    if (q.kind !== 'wake') {
      if (!cache.has(q)) cache.set(q, postUserMessage(rt, threadId, q).message);
      return [cache.get(q)];
    }
    const target = rt.s.sessions[q.sessionIds[0]];
    if (!target || target.archived || target.deleting) {
      deliverWake(rt, threadId, q);
      return [];
    }
    const message = { kind: 'agent', from: `@${q.from}`, text: q.text, itemId: q.itemId, at: q.at };
    return superseded(rt, threadId, message) ? [] : [message];
  });
}

function deliverBatch(rt, threadId, sessionIds, messages) {
  if (!messages.length) return;
  const message = combineMessages(messages);
  for (const id of sessionIds) {
    const se = rt.s.sessions[id];
    if (se && !se.archived && !se.deleting) rt.deliver(id, message, { threadId });
  }
}

export function takePending(rt, se, turn, drain) {
  const groups = batchPending(rt, turn.pending, se.threadId);
  const next = groups.shift();
  if (next) {
    const where = next.threadId ?? se.threadId;
    if (!groups.length && drain && (plainMessage(next.message) || next.message.messages)) {
      const t = pruneStaleWakes(rt, where);
      if (t?.queue?.length) {
        const ready = readyGroups(rt, t, drain === 'wakes');
        for (const batch of takeBatches(rt, where, ready)) {
          if (batch.sessionIds[0] !== se.id) deliverBatch(rt, where, batch.sessionIds, batch.messages);
          else next.message = combineMessages([...(next.message.messages ?? [next.message]), ...batch.messages].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)));
        }
      }
    }
    rt.deliver(se.id, next.message, { summarizeTo: next.summarizeTo, threadId: next.threadId });
    const t = rt.turns.get(se.id);
    if (t) t.pending.push(...groups);
  } else if (drain) rt.drainQueues(se.id, turn.threadId, drain === 'wakes');
}

export function batchPending(rt, pending, threadId) {
  const groups = [];
  for (const entry of pending) {
    const where = entry.threadId ?? threadId;
    if (superseded(rt, where, entry.message)) continue;
    const prior = groups.at(-1);
    const canJoin = !entry.summarizeTo && plainMessage(entry.message);
    if (canJoin && prior && !prior.summarizeTo && (prior.threadId ?? threadId) === where && (plainMessage(prior.message) || prior.message.messages)) {
      prior.message = combineMessages([prior.message, entry.message]);
    } else groups.push({ ...entry });
  }
  return groups;
}

export function drainQueues(rt, sessionId, threadId, wakesOnly = false) {
  const ids = new Set(wakesOnly ? [] : [threadId]);
  for (const t of Object.values(rt.s.threads)) if (t.queue?.some((q) => q.sessionIds.includes(sessionId) && (!wakesOnly || q.kind === 'wake'))) ids.add(t.id);
  for (const id of ids) rt.drainQueue(id, wakesOnly);
}

export function rememberStoppedMessages(rt, sessionId, message) {
  for (const child of message.messages ?? [message])
    if (child.kind === 'agent') rt.tellAgent(sessionId, `${child.from}’s message came while your turn was stopped: “${clip(child.text ?? '', 300)}”`);
}
