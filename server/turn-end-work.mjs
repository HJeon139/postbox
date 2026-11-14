// What happens once a turn’s ledger work is recorded: its last reply, or its last block, gets the list that leads to
// it (#195), and its conversation’s older turns may go to archive files (#305; server/archive-runtime.mjs, off until
// step 4). Work (server/work-service.mjs) calls it as endWork(work, turn, status).

import { turnLine } from '../shared/work.mjs';

/** How a turn ended, for its work: done, stopped by Stop (an abort), or failed. @param {any} err */
export function endedAs(err) {
  if (!err) return 'done';
  if (err.name === 'AbortError') return 'stopped';
  return 'failed';
}

/**
 * The turn’s work is recorded (#132), then its last reply, or its last block, gets the list that leads to it (#195).
 * @param {import('./work-service.mjs').Work} work @param {any} turn @param {string} status
 */
export function endWork(work, turn, status) {
  return (
    work.ledger
      .endTurn(turn, { status })
      .then(() => {
        const line = turn.work ? turnLine(work.ledger.entries(turn.work.convId), turn.id) : null;
        const last = work.store.pending.items(turn.threadId).findLast((x) => x.turnId === turn.id && (x.kind === 'agent' || (x.kind === 'block' && x.valid)));
        if (line && last) work.threads.patchItem(turn.threadId, last.id, { work: line, workTurn: turn.id });
        // Not awaited: the turn has ended, and nothing of it waits for the pass, which never rejects.
        work.archive.conversation(turn.work?.convId ?? work.threads.lineage(turn.threadId).at(-1));
      })
      // Its callers don’t await it: a ledger that fails here must not become an unhandled rejection.
      .catch((e) => console.error(`@${turn.work?.se?.handle ?? 'an agent'}’s turn work wasn’t recorded: ${e instanceof Error ? e.message : e}`))
  );
}
