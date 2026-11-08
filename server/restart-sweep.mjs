// What a restart does with the turns that were running when the server stopped (server/index.mjs).

import { ASKING } from '../shared/catalog.mjs';
import { challengerWins, nextNeed, stateFor } from './card-needs.mjs';

/**
 * Whether the need's card still waits for you after the restart. A failed turn waits for Retry. A permission waits only
 * when its host keeps the prompt: the laptop's own expire right after this sweep (permission-cards.mjs
 * expireStalePermissions). @param {any} rt @param {any} se @param {any} need
 */
function stillWaits(rt, se, need) {
  const card = cardOf(rt, se, need);
  if (!card) return false;
  // A failed reply the person dismissed (#883) waits for nothing, as needOf says.
  if (need.kind === 'failed') return card.status === 'failed' && !card.dismissed;
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
    rt.updateSession(se.id, { ...settledNeed(rt, se), subagents: [], currentStep: 'Interrupted by a restart', stopAsk: null });
  }
}

/**
 * The need and state of an agent whose turn was cut off, by a restart or by a Retry that finds it mid-turn with no
 * turn running (store-outage.mjs settleOrphanTurns): the one rule both go through. It keeps the need while its card
 * still waits, unless a card that ranks ahead now waits; on a tie the newer card, as nextNeed and the turn's end choose.
 * @param {any} rt @param {any} se @returns {{ needs: any, state: string }}
 */
export function settledNeed(rt, se) {
  const needs = keptOrNext(rt, se, nextNeed(rt, se, { keep: se.keptId ?? null }));
  return { needs, state: stateFor(needs) };
}

/** The card a need names, read from pending, as nextNeed reads. @param {any} rt @param {any} se @param {any} need */
function cardOf(rt, se, need) {
  return rt.store.pending.item(need.threadId ?? se.threadId, need.itemId) ?? null;
}

/**
 * The agent’s current need, if its card still waits, or `next`, whichever comes first by `challengerWins`, as nextNeed
 * chooses: `next` is the challenger, so it wins a tie. The restart sweep and a Retry’s reset go through it
 * (settledNeed), so a need nextNeed doesn't count, such as a block from an older turn, isn't dropped while its card
 * waits. @param {any} rt @param {any} se @param {any} next @returns {any}
 */
function keptOrNext(rt, se, next) {
  const cur = se.needs && stillWaits(rt, se, se.needs) ? se.needs : null;
  if (!cur || cur.itemId === next?.itemId) return next ?? cur;
  if (!next) return cur;
  const challenger = { kind: next.kind, at: cardOf(rt, se, next)?.at ?? 0 };
  const incumbent = { kind: cur.kind, at: cardOf(rt, se, cur)?.at ?? 0 };
  if (challengerWins(challenger, incumbent)) return next;
  return cur;
}
