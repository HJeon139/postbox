// What a restart does with the turns that were running when the server stopped (server/index.mjs).

import { nextNeed } from './card-needs.mjs';

/**
 * Turns that were running when the server stopped can't resume: mark them so nothing looks stuck. The agent needs you for
 * the cards that still wait, the interrupted turn's own asks included: it recorded itself as the last turn at its start.
 * @param {any} rt
 */
export function settleInterrupted(rt) {
  for (const se of Object.values(rt.s.sessions)) {
    if (!['think', 'gen', 'tool', 'stopping'].includes(se.state)) continue;
    const needs = nextNeed(rt, se);
    rt.updateSession(se.id, { state: needs ? 'needs' : 'idle', needs, subagents: [], currentStep: 'Interrupted by a restart', stopAsk: null });
  }
}
