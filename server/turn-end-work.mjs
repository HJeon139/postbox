// What happens once a turn’s ledger work is recorded: its last reply gets the list that leads to it (#195), and its
// conversation’s older turns may go to archive files (#305, off by default; server/archive-runtime.mjs).

import { turnLine } from '../shared/work.mjs';

/**
 * @param {any} rt  the runtime
 * @param {any} turn
 * @param {string} status
 */
export function endWork(rt, turn, status) {
  return rt.ledger
    .endTurn(turn, { status })
    .then(() => {
      const line = turn.work ? turnLine(rt.ledger.entries(turn.work.convId), turn.id) : null;
      const last = rt.store.items(turn.threadId).findLast((x) => x.turnId === turn.id && (x.kind === 'agent' || (x.kind === 'block' && x.valid)));
      if (line && last) rt.patchItem(turn.threadId, last.id, { work: line, workTurn: turn.id });
      // Not awaited: the turn has ended, and nothing of it waits for the pass.
      rt.turnArchive.conversation(turn.work?.convId ?? rt.lineage(turn.threadId).at(-1));
    })
    .catch((e) => {
      // Its callers don’t await it: a ledger that fails here must not become an unhandled rejection.
      console.warn(`@${turn.work?.se?.handle ?? 'an agent'}’s turn work wasn’t recorded: ${e instanceof Error ? e.message : e}`);
    });
}
