// What happens to a permission card nobody can answer any more. Moved from server/permission-cards.mjs, which
// re-exports it. Functions take the Runtime first (architecture.md, “What a move may change”).

/**
 * After a restart, no tool call is waiting any more, so open cards can’t be answered. A card of a turn still on a
 * remote host stays open: the host sends its prompt again, or says it expired (#120).
 */
export function expireStalePermissions(rt) {
  for (const [threadId, items] of Object.entries(rt.s.items))
    for (const it of items)
      if (it.kind === 'permission' && it.status === 'open' && !rt.remote.keepsCard(it)) rt.patchItem(threadId, it.id, { status: 'expired' });
}
