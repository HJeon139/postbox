// Erasing a conversation’s threads, with their sessions and apps: what deleting a conversation does, and deleting its
// last agent (#320). Kept apart from server/runtime.mjs, which is at its size; it takes the runtime first.

// Drop only with an audit line; message content is never written to the log.
export function discardHeld(rt, sessionId, reason) {
  const held = rt.heldForUndo.get(sessionId) ?? [];
  rt.heldForUndo.delete(sessionId);
  if (!held.length) return;
  const kinds = new Map();
  for (const [message] of held) kinds.set(message.kind, (kinds.get(message.kind) ?? 0) + 1);
  const list = [...kinds].map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind)).join(', ');
  const se = rt.s.sessions[sessionId];
  const owner = se?.handle ? `@${se.handle}` : `Session ${sessionId}`;
  console.warn(`${owner} ${reason} with ${held.length} held deliver${held.length === 1 ? 'y' : 'ies'} (${list}) undelivered.`);
}

/**
 * Erases these threads, their sessions and their apps, deepest first. `stopped` names sessions whose kept jobs were
 * stopped already, so none is signaled twice.
 * @param {any} rt  the Runtime  @param {string[]} ids  a conversation’s threads, itself first  @param {string} why
 * @param {string[]} [stopped]
 */
export function eraseThreads(rt, ids, why, stopped = []) {
  // Background jobs Postbox kept running for them would run on with no record (#129).
  rt.stopKeptJobs(
    ids.flatMap((id) => rt.s.threads[id]?.members ?? []).filter((sid) => !stopped.includes(sid)),
    why,
  );
  for (const id of ids) {
    for (const sid of rt.s.threads[id]?.members ?? []) {
      discardHeld(rt, sid, 'was removed with its conversation');
      rt.stopMirrorFor(sid);
      if (rt.s.sessions[sid]) rt.store.emit('remove', { kind: 'session', id: sid });
    }
    for (const app of Object.values(rt.s.apps)) if (app.threadId === id) rt.store.emit('remove', { kind: 'app', id: app.id });
  }
  for (const id of [...ids].reverse()) rt.store.emit('remove', { kind: 'thread', id });
}
