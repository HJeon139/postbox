// A conversation owns its agents’ sessions (#320): a session is archived with its conversation, restored with it, and
// deleted with it (Runtime’s archiveThread, restoreThread and deleteThread). Nothing archives a conversation by itself
// any more, so what idle archiving (#101) or an agent archived on its own left hidden comes back here, once.

/**
 * At startup, once: restores every archived conversation and every agent archived on its own, so each is in the rail
 * again. A fork retired by #228 stays archived, since no message reaches it. Returns how many it restored.
 * @param {any} rt  the Runtime
 */
export function restoreArchives(rt) {
  if (rt.s.settings.archivesRestored) return 0;
  const conversations = Object.values(rt.s.threads).filter((t) => t.kind !== 'topic' && t.kind !== 'side' && !t.deleting);
  const hidden = conversations.filter((t) => t.archived || rt.sessionsIn(t.id).some((se) => se.archived && !se.retiredFork));
  for (const t of hidden) rt.restoreThread(t.id);
  rt.store.emit('settings', { archivesRestored: true });
  return hidden.length;
}
