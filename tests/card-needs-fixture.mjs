// What the card-needs specs share (#366): a conversation with @alpha, whose last ended turn is `turn_last`, and helpers
// that add its cards.

import { setup } from './side-threads-fixture.mjs';

/** A conversation with @alpha, whose last ended turn is `turn_last`, and helpers that add its cards. */
export function room() {
  const ctx = setup();
  const { rt, t, alpha } = ctx;
  // The last ended turn is on the session, in the store, so it survives a restart.
  rt.updateSession(alpha.id, { lastTurnId: 'turn_last' });
  const needs = () => rt.s.sessions[alpha.id].needs;
  const setNeed = (kind, itemId) => rt.updateSession(alpha.id, { needs: { kind, itemId, text: kind }, state: 'needs' });
  const appCard = (threadId = t.id) =>
    rt.addItem(threadId, { kind: 'appsend', sessionId: alpha.id, appId: 'app1', title: 'App', events: [{ action: 'x' }], status: 'open' });
  const block = (turnId = 'turn_last', threadId = t.id) =>
    rt.addItem(threadId, {
      kind: 'block',
      sessionId: alpha.id,
      handle: 'alpha',
      turnId,
      valid: true,
      block: { id: `b${Math.random()}`, type: 'choice', version: 1, fallback: 'Pick', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] },
    });
  const permission = () => {
    const it = rt.addItem(t.id, { kind: 'permission', sessionId: alpha.id, handle: 'alpha', summary: 'run ls', status: 'open' });
    rt.permissionWaits.set(it.id, { threadId: t.id, sessionId: alpha.id, timer: null, resolve: () => {} });
    return it;
  };
  // A tool request: a turn-tied ask, as an asking block is, which the specs answer with Off.
  const toolAsk = (turnId = 'turn_last', label = 'Shell') =>
    rt.addItem(t.id, {
      kind: 'toolask',
      sessionId: alpha.id,
      personaId: ctx.a.id,
      handle: 'alpha',
      label,
      tool: 'shell',
      turnId,
      status: 'open',
    });
  const hop = () => rt.addItem(t.id, { kind: 'hop', fromSessionId: alpha.id, from: 'alpha', to: 'beta', status: 'open', text: 'please' });
  return { ...ctx, needs, setNeed, appCard, block, permission, toolAsk, hop };
}
