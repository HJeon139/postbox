// A request an agent makes again while its card from an earlier turn is still open (#1868): a tool request, or a view
// request. Moving on cleared that card’s need (card-needs.mjs TURN_TIED), so the agent asking again is told the card
// waits for the person, and the card becomes this turn’s: the need at once, as a card just raised is (offerShown).

/**
 * Ties the open card to the running turn and offers it as the need. A card already the running turn’s, one asked for
 * with no turn running, and one that still counts through a kept turn (another agent’s wake doesn’t move on,
 * card-needs.mjs keptTurns) are left as they are: re-tied, stopping the wake would take a need that isn’t the wake’s.
 * @param {any} rt @param {any} se  the asking agent @param {any} open  the card @param {string} threadId  where it is
 */
export function askAgain(rt, se, open, threadId) {
  const turnId = rt.turns.get(se.id)?.id ?? null;
  if (!turnId || open.turnId === turnId) return;
  // The session as written, as the turn’s start that set its kept turns may be held behind a commit (#623).
  if ((rt.store.pending.session(se.id)?.keptTurnIds ?? []).includes(open.turnId)) return;
  rt.threads.patchItem(threadId, open.id, { turnId });
  rt.bus.emit('block.asking', { se, item: { ...open, turnId }, threadId });
}
