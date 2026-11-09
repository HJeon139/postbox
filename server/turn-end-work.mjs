// What happens once a turn’s ledger work is recorded: its last reply, or its last block, gets the list that leads to
// it (#195). Moved from server/runtime.mjs, which is at its size; the runtime keeps a one-line delegator.

import { turnLine } from '../shared/work.mjs';

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
      })
      // Its callers don’t await it: a ledger that fails here must not become an unhandled rejection.
      .catch((e) => console.error(`@${turn.work?.se?.handle ?? 'an agent'}’s turn work wasn’t recorded: ${e instanceof Error ? e.message : e}`))
  );
}
