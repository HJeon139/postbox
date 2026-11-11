// A turn that doesn't move on keeps every turn's cards that counted when it started (#366; critic's review of #633 at
// e776d4b0): another agent's wake, a lint pass or an app check isn't the person moving on, so the refusals and tool
// requests of the turn before still count, mid-turn, at its end and after a restart. And a laptop's permission card
// left open across a restart is no longer the need (#721's first gap).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { offerNeed } from '../server/card-needs.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';

/** A second runtime on the same store, as a restart makes one: the sweep, then the laptop's cards expire. */
function restart(r) {
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  rt.expireStalePermissions();
  return rt;
}

/** Two refusals from `turn_last`, the need on the first, then another agent wakes @alpha and its turn runs on. */
async function wokenWithTwoRefusals(r) {
  const d1 = r.denial('ls');
  const d2 = r.denial('pwd');
  r.setNeed('denial', d1.id);
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' }); // not you moving on
  await sleep(5);
  return { d1, d2, work };
}

test('critic’s probe: after a restart cuts off a wake, answering one refusal moves the need to the next, as on main', async () => {
  const r = room();
  const { d1, d2 } = await wokenWithTwoRefusals(r);
  const rt = restart(r);
  await rt.resolveDenial(r.t.id, d1.id, 'leave');
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(se.needs?.itemId, d2.id, 'd2 still waits');
  assert.equal(se.state, 'needs');
});

test('mid-turn: answering one refusal during a wake moves the need to the next, as on main', async () => {
  const r = room();
  const { d1, d2, work } = await wokenWithTwoRefusals(r);
  await r.rt.resolveDenial(r.t.id, d1.id, 'leave');
  assert.equal(r.needs()?.itemId, d2.id, 'mid-turn');
  work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, d2.id, 'and at the wake’s end');
});

test('a wake that ends leaves the turn before’s refusals counting', async () => {
  const r = room();
  const { d1, work } = await wokenWithTwoRefusals(r);
  work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.kind, 'denial', 'the refusals still wait');
  await r.rt.resolveDenial(r.t.id, d1.id, 'leave');
  assert.equal(r.needs()?.kind, 'denial', 'answering one leaves the other');
});

test('two wakes in a row: the first wake’s own refusals still count once the second starts and a restart cuts it off', async () => {
  const r = room();
  const first = held();
  /** @type {any[]} */
  const mine = [];
  r.adapter.next.push(async (c, _m, se) => {
    const turnId = r.rt.turns.get(se.id).id;
    mine.push(r.denial('git status', turnId), r.denial('git log', turnId));
    await first.step(c);
  });
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'One.' });
  await sleep(5);
  first.release();
  await settle(r.rt);
  assert.equal(r.needs()?.kind, 'denial');
  r.adapter.next.push(held().step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Two.' });
  await sleep(5);
  const rt = restart(r);
  const [answered, other] = r.needs()?.itemId === mine[0].id ? mine : [mine[1], mine[0]];
  await rt.resolveDenial(r.t.id, answered.id, 'leave');
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.itemId, other.id, 'the first wake’s other refusal');
});

test('moving on still clears the turn before’s refusals, after a wake kept them', async () => {
  const r = room();
  const { work } = await wokenWithTwoRefusals(r);
  work.release();
  await settle(r.rt);
  r.rt.sendMessage(r.t.id, { text: '@alpha carry on' }); // you move on
  await settle(r.rt);
  assert.equal(r.needs(), null, 'refusals you moved past stay quiet (#69)');
  const se = r.store.state.sessions[r.alpha.id];
  assert.deepEqual(se.keptTurnIds ?? [], [], 'nothing kept after you move on');
});

test('#721’s first gap: a laptop’s permission card open across a restart leaves no need', async () => {
  const r = room();
  const p = r.permission();
  r.setNeed('permission', p.id);
  restart(r);
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(r.store.item(r.t.id, p.id).status, 'expired');
  assert.equal(se.needs, null, 'no need on an expired card');
  assert.equal(se.state, 'idle');
});

test('a wake keeps only turns still asking you something, so the list doesn’t grow with every wake', async () => {
  const r = room();
  r.denial('ls', 'turn_old'); // a turn no longer counting: not kept
  r.adapter.next.push(async () => {});
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'One.' });
  await settle(r.rt);
  assert.deepEqual(r.store.state.sessions[r.alpha.id].keptTurnIds, [], 'turn_last asked nothing');
  const d = r.denial('pwd', r.store.state.sessions[r.alpha.id].lastTurnId);
  r.adapter.next.push(async () => {});
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Two.' });
  await settle(r.rt);
  assert.deepEqual(r.store.state.sessions[r.alpha.id].keptTurnIds, [d.turnId], 'only the wake that left a refusal open');
});

test('a wake’s end keeps a failed turn’s need and its Retry, where main drops it', async () => {
  const r = room();
  const f = r.rt.addItem(r.t.id, { kind: 'agent', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', text: '', status: 'failed', error: 'x' });
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'failed', itemId: f.id, text: 'failed' }, state: 'failed' });
  r.adapter.next.push(async (c) => c.text('Thanks, noted.'));
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' });
  await settle(r.rt);
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(se.needs?.itemId, f.id, `Retry still waits, not ${JSON.stringify(se.needs)}`);
  assert.equal(se.state, 'failed');
});

/** A failed reply is the need, another agent wakes @alpha, and the wake asks a permission that takes the need. */
async function failedThenWakeWithPermission(r) {
  const f = r.rt.addItem(r.t.id, { kind: 'agent', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', text: '', status: 'failed', error: 'boom' });
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'failed', itemId: f.id, text: 'boom' }, state: 'failed' });
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'FYI.' });
  await sleep(5);
  const p = r.permission();
  offerNeed(r.rt, r.rt.s.sessions[r.alpha.id], { kind: 'permission', itemId: p.id, text: 'p' }, 'needs');
  return { f, p, work };
}

test('the packet’s probe: a wake’s permission answered, then its end, leaves the failed reply’s Retry as the need', async () => {
  const r = room();
  const { f, p, work } = await failedThenWakeWithPermission(r);
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs()?.itemId, f.id, 'mid-wake, once the permission is answered');
  work.release();
  await settle(r.rt);
  const se = r.rt.s.sessions[r.alpha.id];
  assert.equal(se.needs?.itemId, f.id, 'and at the wake’s end');
  assert.equal(se.state, 'failed');
});

test('…and a restart while the wake’s permission is the need leaves the failed reply’s Retry as the need', async () => {
  const r = room();
  const { f } = await failedThenWakeWithPermission(r);
  restart(r);
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(se.needs?.itemId, f.id);
  assert.equal(se.state, 'failed');
});

/** A block from a turn that no longer counts is the need (a restart kept it, as main does), then a wake runs. */
async function wakeOnOldBlock(r) {
  const b = r.block('turn_old');
  r.setNeed('block', b.id);
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'FYI.' });
  await sleep(5);
  return { b, work };
}

test('a block from an older turn that was the need stays the need through a wake: only keptId keeps it', async () => {
  const r = room();
  const { b, work } = await wakeOnOldBlock(r);
  assert.deepEqual(r.rt.s.sessions[r.alpha.id].keptTurnIds, [], 'its turn isn’t a kept turn');
  work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, b.id);
});

test('…and through a permission mid-wake and a restart', async () => {
  const r = room();
  const { b } = await wakeOnOldBlock(r);
  const p = r.permission();
  r.setNeed('permission', p.id);
  restart(r);
  assert.equal(r.store.state.sessions[r.alpha.id].needs?.itemId, b.id);
});

test('after a restart, answering the card ahead of a failed reply brings back its Retry, in the failed state', async () => {
  const r = room();
  const { p } = await failedThenWakeWithPermission(r);
  const card = r.appCard();
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'appsend', itemId: card.id, text: 'App' }, state: 'needs' });
  r.rt.settlePermission(p.id, 'allowed');
  const rt = restart(r);
  rt.resolveAppSend(r.t.id, card.id, 'deny');
  const se = r.store.state.sessions[r.alpha.id];
  assert.equal(se.needs?.kind, 'failed');
  assert.equal(se.state, 'failed', 'Retry shows, not a plain needs-you');
});
