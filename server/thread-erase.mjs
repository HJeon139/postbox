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
  );
  for (const id of ids) {
    for (const sid of rt.s.threads[id]?.members ?? []) {
      rt.stopMirrorFor(sid);
      if (rt.s.sessions[sid]) rt.store.emit('remove', { kind: 'session', id: sid });
    }
    for (const app of Object.values(rt.s.apps)) if (app.threadId === id) rt.store.emit('remove', { kind: 'app', id: app.id });
  }
  for (const id of [...ids].reverse()) rt.store.emit('remove', { kind: 'thread', id });
}
