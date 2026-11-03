// What a restart does with the turns that were running when the server stopped (server/index.mjs).

import { nextNeed } from './card-needs.mjs';

/**
 * Turns that were running when the server stopped can't resume: mark them so nothing looks stuck. The agent needs you for
 * the cards that still wait: the interrupted turn's own asks (it recorded itself as the last turn at its start), and the
 * block it kept if it didn't move on.
 * @param {any} rt
 */
export function settleInterrupted(rt) {
  for (const se of Object.values(rt.s.sessions)) {
    // A turn was running: its state says so, or a permission it was blocked on is the need, which only a running turn
    // has (its card expires on the restart: permission-cards.mjs expireStalePermissions).
    if (!['think', 'gen', 'tool', 'stopping'].includes(se.state) && se.needs?.kind !== 'permission') continue;
    // The block a turn that didn't move on kept still counts (keptId, in the store), even if a permission had the need.
    const needs = nextNeed(rt, se, { keep: se.keptId ?? null });
    rt.updateSession(se.id, { state: needs ? 'needs' : 'idle', needs, keptId: null, subagents: [], currentStep: 'Interrupted by a restart', stopAsk: null });
  }
}
