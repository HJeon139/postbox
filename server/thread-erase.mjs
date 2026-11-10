// Erasing a conversation’s threads, with their sessions and apps: what deleting a conversation does, and deleting its
// last agent (#320). Kept apart from server/runtime.mjs, which is at its size; it takes the runtime first.

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
      // A turn it still has would run on for a session that’s gone.
      if (rt.turns?.has(sid)) rt.stop(sid, { silent: true });
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
