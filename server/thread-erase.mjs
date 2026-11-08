// Erasing a conversation’s threads, with their sessions and apps: what deleting a conversation does, and deleting its
// last agent (#320), with what its Undo window holds back. Kept apart from server/runtime.mjs, which is at its size;
// it takes the runtime first.

/**
 * Whether a thread’s conversation is being deleted: deleteThread marks its root alone, so a side thread’s agent is
 * held too (#725). Read pending, as sendMessage reads it: a delete held behind a commit holds what comes meanwhile
 * (#796). @param {any} rt @param {string} threadId
 */
export function conversationDeleting(rt, threadId) {
  const pending = (/** @type {string} */ id) => rt.store.pending.thread(id);
  return Boolean(pending(rt.lineage(threadId, pending).at(-1))?.deleting);
}

/** Delivers what deliver held for a session in an Undo window, in the order it came. @param {any} rt @param {string} sessionId */
export function releaseHeld(rt, sessionId) {
  const held = rt.heldForUndo.get(sessionId) ?? [];
  rt.heldForUndo.delete(sessionId);
  for (const [message, options] of held) rt.deliver(sessionId, message, options);
}

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
  ).catch((e) => console.error(`Postbox couldn’t stop the background jobs of a removed conversation: ${e.message}`));
  for (const id of ids) {
    for (const sid of rt.s.threads[id]?.members ?? []) {
      // A turn it still has, one that started in the Undo window, would run on for a session that’s gone (#725).
      if (rt.turns?.has(sid)) rt.stop(sid, { silent: true });
      discardHeld(rt, sid, 'was removed with its conversation');
      rt.stopMirrorFor(sid);
      if (rt.s.sessions[sid]) rt.store.emit('remove', { kind: 'session', id: sid });
    }
    for (const app of Object.values(rt.store.pending.apps())) if (app.threadId === id) rt.store.emit('remove', { kind: 'app', id: app.id });
  }
  // A conversation’s root takes its room’s assets with it (#516 S3, the person’s choice of 2 November 2026); a topic or
  // side thread alone is never a room, so it takes none.
  for (const id of ids) if (!rt.s.threads[id]?.parentId) rt.store.emit('asset.erase', { room: id, at: Date.now() });
  for (const id of [...ids].reverse()) rt.store.emit('remove', { kind: 'thread', id });
}
