// An agent needs you until its last waiting card is answered (#366; the integrator's review of #608): answering one card
// falls back to the newest card that still waits, a second app card is noticed, and a resolver only clears its own need.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** A conversation with @alpha, whose last ended turn is `turn_last`, and helpers that add its cards. */
function room() {
  const ctx = setup();
  const { rt, t, alpha } = ctx;
  rt.lastTurn.set(alpha.id, 'turn_last');
  const needs = () => rt.s.sessions[alpha.id].needs;
  const setNeed = (kind, itemId) => rt.updateSession(alpha.id, { needs: { kind, itemId, text: kind }, state: 'needs' });
  const appCard = () => rt.addItem(t.id, { kind: 'appsend', sessionId: alpha.id, appId: 'app1', title: 'App', events: [{ action: 'x' }], status: 'open' });
  const block = (turnId = 'turn_last') =>
    rt.addItem(t.id, {
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
  const toolAsk = () =>
    rt.addItem(t.id, {
      kind: 'toolask',
      sessionId: alpha.id,
      personaId: ctx.a.id,
      handle: 'alpha',
      label: 'Shell',
      tool: 'shell',
      turnId: 'turn_last',
      status: 'open',
    });
  const hop = () => rt.addItem(t.id, { kind: 'hop', fromSessionId: alpha.id, from: 'alpha', to: 'beta', status: 'open', text: 'please' });
  return { ...ctx, needs, setNeed, appCard, block, permission, toolAsk, hop };
}

test('#366 case 1: an app card, then a permission card; allowing the permission leaves the agent needing you for the app card', async () => {
  const r = room();
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  const p = r.permission();
  r.setNeed('permission', p.id);
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs()?.itemId, app.id);
  assert.equal(r.needs()?.kind, 'appsend');
});

test('#366 case 1: an app card, then a block; answering the block leaves the agent needing you for the app card', async () => {
  const r = room();
  const app = r.appCard();
  const b = r.block();
  r.setNeed('block', b.id);
  r.rt.act(r.t.id, b.id, 'choose', { selected: ['a'] });
  assert.equal(r.needs()?.itemId, app.id);
  await settle(r.rt);
});

test('#366 case 1: an app card, then a tool request; answering it leaves the agent needing you for the app card', async () => {
  const r = room();
  const app = r.appCard();
  const ask = r.toolAsk();
  r.setNeed('toolask', ask.id);
  r.rt.act(r.t.id, ask.id, 'off');
  assert.equal(r.needs()?.itemId, app.id);
  await settle(r.rt);
});

test('#366 case 1: an app card, then a failed reply; Retry leaves the agent needing you for the app card', async () => {
  const r = room();
  const app = r.appCard();
  const failed = r.rt.addItem(r.t.id, {
    kind: 'agent',
    sessionId: r.alpha.id,
    handle: 'alpha',
    text: '',
    status: 'failed',
    asked: { message: { kind: 'user', text: 'again' }, summarizeTo: null },
  });
  r.setNeed('failed', failed.id);
  await r.rt.retry(r.t.id, failed.id);
  assert.equal(r.needs()?.itemId, app.id);
  await settle(r.rt);
});

test('#366 case 2: two app cards; answering the first leaves the agent needing you for the second, notified once', async () => {
  const r = room();
  const notes = [];
  r.rt.notify = (_level, _se, title) => notes.push(title);
  const app = { sessionId: r.alpha.id, title: 'App', threadId: r.t.id };
  const first = r.appCard();
  r.rt.needAppSend(app, first.id, 1);
  const second = r.appCard();
  r.rt.needAppSend(app, second.id, 1);
  assert.equal(notes.length, 1, 'the second card is not notified while the first is the need');
  r.rt.resolveAppSend(r.t.id, first.id, 'deny');
  assert.equal(r.needs()?.itemId, second.id);
  assert.equal(notes.length, 2, 'the second card is notified once it becomes the need');
  r.rt.resolveAppSend(r.t.id, second.id, 'deny');
  assert.equal(notes.length, 2, 'and not again');
});

test('the integrator’s item: a block is the need, then a wake request; allowing the request leaves the need on the block', async () => {
  const r = room();
  const b = r.block();
  const h = r.hop();
  r.setNeed('hop', h.id);
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs()?.itemId, b.id);
});

test('the integrator’s item: an app card is the need, and a wake request that is not the need is answered; the need stays', async () => {
  const r = room();
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  const h = r.hop();
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs()?.itemId, app.id, 'a resolver clears only its own need');
});

test('the integrator’s item: Retry of a failed reply does not clear an app card’s need', async () => {
  const r = room();
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  const failed = r.rt.addItem(r.t.id, {
    kind: 'agent',
    sessionId: r.alpha.id,
    handle: 'alpha',
    text: '',
    status: 'failed',
    asked: { message: { kind: 'user', text: 'again' }, summarizeTo: null },
  });
  await r.rt.retry(r.t.id, failed.id);
  assert.equal(r.needs()?.itemId, app.id);
  await settle(r.rt);
});

test('#69 through the fallback: a block from an older turn does not come back as the need', async () => {
  const r = room();
  r.block('turn_older');
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  r.rt.resolveAppSend(r.t.id, app.id, 'deny');
  assert.equal(r.needs(), null);
});

test('when the last card is answered the agent is idle', async () => {
  const r = room();
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  r.rt.resolveAppSend(r.t.id, app.id, 'deny');
  assert.equal(r.needs(), null);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'idle');
});

test('a resolver whose card is not the need leaves the need where it is, even when a newer card waits', async () => {
  const r = room();
  const b = r.block();
  r.setNeed('block', b.id);
  r.appCard(); // newer, and not the need
  const h = r.hop();
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs()?.itemId, b.id, 'answering a card that is not the need changes nothing');
});
