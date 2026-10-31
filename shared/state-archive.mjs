// An old turn leaving the in-memory state (#305; the design, “Old turns’ work and activity leave the in-memory state”):
// its work entries give way to one turn summary entry, and its replies keep only how many activity steps they had. The
// rest is in the turn’s archive file, named by its SHA-256, which the server wrote before this event.

/**
 * Applies a 'turn.archive' event; false for any other type. Idempotent: a turn already archived changes nothing.
 * @param {any} s @param {string} type
 * @param {any} d  { convId, turnId, sha256, summary, items: reply ids }
 */
export function applyTurnArchive(s, type, d) {
  if (type !== 'turn.archive') return false;
  const list = s.work?.[d.convId];
  if (list && !list.some((/** @type {any} */ e) => e.kind === 'turn-archive' && e.turnId === d.turnId)) {
    const at = list.findIndex((/** @type {any} */ e) => e.turnId === d.turnId);
    const kept = list.filter((/** @type {any} */ e) => e.turnId !== d.turnId);
    kept.splice(at < 0 ? kept.length : at, 0, d.summary);
    s.work[d.convId] = kept;
  }
  const ids = new Set(d.items ?? []);
  for (const it of s.items?.[d.convId] ?? [])
    if (ids.has(it.id) && it.activity && !it.activity.archived) it.activity = { archived: d.sha256, steps: it.activity.steps?.length ?? 0 };
  return true;
}
