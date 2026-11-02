// The work ledger by turn and by id (#618), so one turn’s summary reads that turn’s entries, not the conversation’s,
// and an event names its entry without a scan. A conversation’s entries only grow: work.add pushes to the array and
// work.patch changes an entry in place (shared/state.mjs). So an index is kept per array, holds the entries
// themselves (a patch shows through it), and takes in only what was pushed since it last looked.

/** @typedef {{ seen: number, byId: Map<string, any>, byTurn: Map<string, any[]>, files: Map<string, any> }} LedgerIndex */

/** @type {WeakMap<any[], LedgerIndex>} */
const indexes = new WeakMap();

/**
 * The index of one conversation’s entries (state.work[conversationId]): each entry by id (the first with it), each
 * turn’s entries in order, its own included, and the files.
 * @param {any[]} entries
 * @returns {LedgerIndex}
 */
export function ledgerIndex(entries) {
  let ix = indexes.get(entries);
  if (!ix || ix.seen > entries.length) {
    ix = { seen: 0, byId: new Map(), byTurn: new Map(), files: new Map() };
    indexes.set(entries, ix);
  }
  for (; ix.seen < entries.length; ix.seen++) {
    const e = entries[ix.seen];
    if (!ix.byId.has(e.id)) ix.byId.set(e.id, e);
    if (e.kind === 'file') ix.files.set(e.id, e);
    const turnId = e.kind === 'turn' ? (e.turnId ?? e.id) : e.turnId;
    if (!turnId) continue;
    const list = ix.byTurn.get(turnId);
    if (list) list.push(e);
    else ix.byTurn.set(turnId, [e]);
  }
  return ix;
}
