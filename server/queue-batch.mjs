// Queue batches keep per-agent order and thread boundaries; later turns can supersede a waker’s old request (#374).

/** @param {any} rt @param {any} thread @param {boolean} wakesOnly */
export function readyGroups(rt, thread, wakesOnly) {
  const blocked = new Set();
  const groups = new Map();
  for (const q of thread.queue ?? []) {
    if (wakesOnly && q.kind !== 'wake') continue;
    const free = !q.sessionIds.some((id) => blocked.has(id) || rt.turns.has(id) || rt.exiting.has(id));
    if (!free) {
      for (const id of q.sessionIds) blocked.add(id);
      continue;
    }
    for (const id of q.sessionIds) {
      if (!groups.has(id)) groups.set(id, { sessionIds: [id], entries: [] });
      groups.get(id).entries.push(q);
    }
  }
  return [...groups.values()];
}

/** A turn’s later streaming segments are the same post, not a new instruction from its author. */
export function superseded(rt, threadId, message) {
  if (message.kind !== 'agent') return false;
  const from = String(message.from ?? '')
    .replace(/^@/, '')
    .toLowerCase();
  const items = rt.store.items(threadId);
  const index = items.findIndex((item) => item.id === message.itemId);
  const source = items[index];
  const turnId = source?.fromTurnId ?? source?.turnId;
  return items.slice(index + 1).some((item) => {
    if (item.kind !== 'agent' || String(item.handle ?? '').toLowerCase() !== from || !String(item.text ?? '').trim()) return false;
    if (index < 0 && !(item.at > message.at)) return false;
    return !turnId || turnId !== (item.fromTurnId ?? item.turnId);
  });
}

export const plainMessage = (message) => ['user', 'agent'].includes(message.kind) && !message.slash && !message.messages;

/** @param {any[]} messages */
export function combineMessages(messages) {
  const all = messages.flatMap((message) => message.messages ?? [message]);
  if (all.length === 1) return all[0];
  const last = all.at(-1);
  return {
    kind: all.some((message) => message.kind === 'user') ? 'user' : 'agent',
    from: last.from,
    text: all.map((message) => message.text ?? '').join('\n\n'),
    itemId: last.itemId,
    messages: all,
  };
}
