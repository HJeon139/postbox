// What happens once a turn’s ledger work is recorded: its last reply, or its last block, gets the list that leads to
// it (#195), and its conversation’s older turns may go to archive files (#305; server/archive-runtime.mjs, off until
// step 4). Moved from server/runtime.mjs, which is at its size; the runtime calls it as endWork(rt, turn, status).

import { turnLine } from '../shared/work.mjs';

/** How a turn ended, for its work: done, stopped by Stop (an abort), or failed. @param {any} err */
export function endedAs(err) {
  if (!err) return 'done';
  if (err.name === 'AbortError') return 'stopped';
  return 'failed';
}

/**
 * The turn’s work is recorded (#132), then its last reply, or its last block, gets the list that leads to it (#195).
 * @param {any} rt  the runtime @param {any} turn @param {string} status
 */
export function endWork(rt, turn, status) {
  return (
    rt.ledger
      .endTurn(turn, { status })
      .then(() => {
        const line = turn.work ? turnLine(rt.ledger.entries(turn.work.convId), turn.id) : null;
        const last = rt.store.pending.items(turn.threadId).findLast((x) => x.turnId === turn.id && (x.kind === 'agent' || (x.kind === 'block' && x.valid)));
        if (line && last) rt.patchItem(turn.threadId, last.id, { work: line, workTurn: turn.id });
        // Not awaited: the turn has ended, and nothing of it waits for the pass, which never rejects.
        rt.turnArchive.conversation(turn.work?.convId ?? rt.lineage(turn.threadId).at(-1));
      })
      // Its callers don’t await it: a ledger that fails here must not become an unhandled rejection.
      .catch((e) => console.error(`@${turn.work?.se?.handle ?? 'an agent'}’s turn work wasn’t recorded: ${e instanceof Error ? e.message : e}`))
  );
}
