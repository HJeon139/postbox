// What a restart does with the turns that were running when the server stopped (server/index.mjs).

import { ASKING } from '../shared/catalog.mjs';
import { nextNeed, RANK } from './card-needs.mjs';

/**
 * Whether the need's card still waits for you after the restart. A failed turn waits for Retry. A permission waits only
 * when its host keeps the prompt: the laptop's own expire right after this sweep (permission-cards.mjs
 * expireStalePermissions). @param {any} rt @param {any} se @param {any} need
 */
function stillWaits(rt, se, need) {
  const card = rt.store.pending.items(need.threadId ?? se.threadId).find((/** @type {any} */ x) => x.id === need.itemId);
  if (!card) return false;
  if (need.kind === 'failed') return card.status === 'failed';
  if (need.kind === 'permission') return card.status === 'open' && rt.remote.keepsCard(card);
  if (need.kind === 'block') return card.valid && ASKING.has(card.block?.type) && !card.answered;
  return card.status === 'open';
}

/**
 * Turns that were running when the server stopped can't resume: mark them so nothing looks stuck. The agent keeps the
 * need it had while its card still waits, as main does, unless a card that ranks ahead now waits: the interrupted turn's
 * own asks (it recorded itself as the last turn at its start), or the block it kept if it didn't move on.
 * @param {any} rt
 */
export function settleInterrupted(rt) {
  for (const se of Object.values(rt.s.sessions)) {
    // A turn was running: its state says so, or a permission it was blocked on is the need, which only a running turn has.
    if (!['think', 'gen', 'tool', 'stopping'].includes(se.state) && se.needs?.kind !== 'permission') continue;
    const next = nextNeed(rt, se, { keep: se.keptId ?? null });
    const cur = se.needs && stillWaits(rt, se, se.needs) ? se.needs : null;
    // The newest card of the first rank, as nextNeed and the turn's end choose: a tie goes to the newer card.
    const needs = cur && !(next && RANK[next.kind] <= RANK[cur.kind]) ? cur : next;
    const state = needs?.kind === 'failed' ? 'failed' : needs ? 'needs' : 'idle';
    rt.updateSession(se.id, { state, needs, subagents: [], currentStep: 'Interrupted by a restart', stopAsk: null });
  }
}
