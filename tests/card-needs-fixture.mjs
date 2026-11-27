// What the card-needs specs share (#366): a conversation with @alpha, whose last ended turn is `turn_last`, and helpers
// that add its cards.

import { offerNeed, releaseNeed } from '../server/card-needs.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

/** A conversation with @alpha, whose last ended turn is `turn_last`, and helpers that add its cards. */
export function room() {
  const ctx = setup();
  const { rt, t, alpha } = ctx;
  // The last ended turn is on the session, in the store, so it survives a restart.
  arrange.setSession(rt, alpha.id, { lastTurnId: 'turn_last' });
  const needs = () => rt.s.sessions[alpha.id].needs;
  const setNeed = (kind, itemId) => arrange.setSession(rt, alpha.id, { needs: { kind, itemId, text: kind }, state: 'needs' });
  const block = (turnId = 'turn_last', threadId = t.id) =>
    arrange.post(rt, threadId, {
      kind: 'block',
      sessionId: alpha.id,
      handle: 'alpha',
      turnId,
      valid: true,
      block: { id: `b${Math.random()}`, type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
    });
  const permission = () => {
    const it = arrange.post(rt, t.id, { kind: 'permission', sessionId: alpha.id, handle: 'alpha', summary: 'run ls', status: 'open' });
    rt.permissionWaits.set(it.id, { threadId: t.id, sessionId: alpha.id, timer: null, resolve: () => {} });
    return it;
  };
  // A tool request: a turn-tied ask, as an asking block is, which the specs answer with Off.
  const toolAsk = (turnId = 'turn_last', label = 'Shell') =>
    arrange.post(rt, t.id, {
      kind: 'toolask',
      sessionId: alpha.id,
      personaId: ctx.a.id,
      handle: 'alpha',
      label,
      tool: 'shell',
      turnId,
      status: 'open',
    });
  // A wake request: an add card, which waits until answered, whatever the turn.
  const hop = (threadId = t.id) =>
    arrange.post(rt, threadId, { kind: 'hop', join: true, fromSessionId: alpha.id, from: 'alpha', to: 'beta', status: 'open', text: 'please' });
  // A wake request offers itself as the need, as server/wake-cards.mjs does when it raises one. `on` is the runtime, a
  // restart's when the spec made one.
  const offerHop = (card, { threadId = t.id, on = rt } = {}) => {
    const se = on.s.sessions[alpha.id];
    const need = { kind: 'hop', itemId: card.id, text: 'hop', ...on.sessions.awayFrom(se, threadId) };
    return offerNeed(on, se, need, on.turns.has(se.id) ? se.state : 'needs');
  };
  // The person declines a wake request and its need is released, as resolveHop does, without the notice that wakes the
  // agent to tell it: a spec that reads the agent's state after the answer needs no turn started.
  const declineHop = (card, { on = rt } = {}) => {
    arrange.setItem(on, t.id, card.id, { status: 'declined' });
    releaseNeed(on, on.s.sessions[alpha.id], card.id);
  };
  return { ...ctx, needs, setNeed, block, permission, toolAsk, hop, offerHop, declineHop };
}
