// An agent needs you until its last waiting card is answered (#366; the integrator's review of #608): answering one card
// falls back to the newest card that still waits, and a resolver only clears its own need.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';

test('#366 case 1: a wake request, then a permission card; allowing the permission leaves the agent needing you for the request', async () => {
  const r = room();
  const h = r.hop();
  r.setNeed('hop', h.id);
  const p = r.permission();
  r.setNeed('permission', p.id);
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs()?.itemId, h.id);
  assert.equal(r.needs()?.kind, 'hop');
});

test('#366 case 1: a wake request, then a block; answering the block leaves the agent needing you for the request', async () => {
  const r = room();
  const h = r.hop();
  const b = r.block();
  r.setNeed('block', b.id);
  r.rt.act(r.t.id, b.id, 'choose', { selected: ['a'] });
  assert.equal(r.needs()?.itemId, h.id);
  await settle(r.rt);
});

test('#366 case 1: a wake request, then a tool request; answering it leaves the agent needing you for the wake request', async () => {
  const r = room();
  const h = r.hop();
  const ask = r.toolAsk();
  r.setNeed('toolask', ask.id);
  r.rt.act(r.t.id, ask.id, 'off');
  assert.equal(r.needs()?.itemId, h.id);
  await settle(r.rt);
});

test('#366 case 1: a wake request, then a failed reply; Retry leaves the agent needing you for the request', async () => {
  const r = room();
  const h = r.hop();
  const failed = arrange.post(r.rt, r.t.id, {
    kind: 'agent',
    sessionId: r.alpha.id,
    handle: 'alpha',
    text: '',
    status: 'failed',
    asked: { message: { kind: 'user', text: 'again' }, summarizeTo: null },
  });
  r.setNeed('failed', failed.id);
  await r.rt.retry(r.t.id, failed.id);
  assert.equal(r.needs()?.itemId, h.id);
  await settle(r.rt);
});

test('#366 case 2: two wake requests; the second is the need at once, and answering it leaves the first', async () => {
  const r = room();
  const first = r.hop();
  r.offerHop(first);
  const second = r.hop();
  r.offerHop(second);
  // Same rank, newest first, whether set or released (offerNeed; the integrator's review of #633, point 3).
  assert.equal(r.needs()?.itemId, second.id, 'the newer card is the need');
  r.rt.resolveHop(r.t.id, second.id, false);
  assert.equal(r.needs()?.itemId, first.id, 'answering it leaves the first');
});

test('the integrator’s item: a block is the need, then a wake request; allowing the request leaves the need on the block', async () => {
  const r = room();
  const b = r.block();
  const h = r.hop();
  r.setNeed('hop', h.id);
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs()?.itemId, b.id);
});

test('the integrator’s item: a wake request is the need, and another that is not the need is answered; the need stays', async () => {
  const r = room();
  const need = r.hop();
  r.setNeed('hop', need.id);
  const h = r.hop();
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs()?.itemId, need.id, 'a resolver clears only its own need');
});

test('the integrator’s item: Retry of a failed reply does not clear a wake request’s need', async () => {
  const r = room();
  const h = r.hop();
  r.setNeed('hop', h.id);
  const failed = arrange.post(r.rt, r.t.id, {
    kind: 'agent',
    sessionId: r.alpha.id,
    handle: 'alpha',
    text: '',
    status: 'failed',
    asked: { message: { kind: 'user', text: 'again' }, summarizeTo: null },
  });
  await r.rt.retry(r.t.id, failed.id);
  assert.equal(r.needs()?.itemId, h.id);
  await settle(r.rt);
});

test('#69 through the fallback: a block from an older turn does not come back as the need', async () => {
  const r = room();
  r.block('turn_older');
  const h = r.hop();
  r.setNeed('hop', h.id);
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs(), null);
});

test('when the last card is answered the agent is idle', async () => {
  const r = room();
  const h = r.hop();
  r.setNeed('hop', h.id);
  r.declineHop(h);
  assert.equal(r.needs(), null);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'idle');
});

test('a resolver whose card is not the need leaves the need where it is, even when a newer card waits', async () => {
  const r = room();
  const b = r.block();
  r.setNeed('block', b.id);
  r.hop(); // newer, and not the need
  const h = r.hop();
  r.rt.resolveHop(r.t.id, h.id, false);
  assert.equal(r.needs()?.itemId, b.id, 'answering a card that is not the need changes nothing');
});

test('an open refusal is never a need, alone or beside an asking block (intent.md, principle 8)', async () => {
  const r = room();
  const { nextNeed } = await import('../server/card-needs.mjs');
  for (const s of ['one', 'two'])
    arrange.post(r.rt, r.t.id, { kind: 'denial', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', summary: s, status: 'open' });
  assert.equal(nextNeed(r.rt, r.rt.s.sessions[r.alpha.id]), null, 'the agent works around a refusal');
  const b = r.block();
  assert.equal(nextNeed(r.rt, r.rt.s.sessions[r.alpha.id])?.itemId, b.id, 'the question');
});

test('within a kind the newest card comes first: two wake requests wait, and the newer is the need', async () => {
  const r = room();
  r.hop();
  await sleep(3); // a later `at`, so the order is by time and not by a tie
  const newer = r.hop();
  const b = r.block();
  r.setNeed('block', b.id);
  r.rt.act(r.t.id, b.id, 'choose', { selected: ['a'] });
  assert.equal(r.needs()?.itemId, newer.id);
  await settle(r.rt);
});

test('a permission card whose wait has ended does not count', async () => {
  const r = room();
  const h = r.hop();
  const p = r.permission();
  r.rt.permissionWaits.delete(p.id); // the turn that asked has ended
  const { nextNeed } = await import('../server/card-needs.mjs');
  assert.equal(nextNeed(r.rt, r.rt.s.sessions[r.alpha.id])?.itemId, h.id);
});

test('a wake request that waited behind an older block becomes the need at the turn’s end', async () => {
  const r = room();
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.sendMessage(r.t.id, { text: '@alpha a long job' });
  await sleep(5);
  const b = r.block();
  r.setNeed('block', b.id);
  const card = r.hop();
  r.offerHop(card);
  assert.equal(r.needs()?.itemId, b.id, 'the block, which ranks ahead, stays the need');
  work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, card.id, 'the wake request is the need at the turn’s end, the block being from a turn moved past');
});

test('moving on clears a failed turn’s need, as main does', async () => {
  const r = room();
  const f = arrange.post(r.rt, r.t.id, { kind: 'agent', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', text: '', status: 'failed', error: 'x' });
  arrange.setSession(r.rt, r.alpha.id, { needs: { kind: 'failed', itemId: f.id, text: 'x' }, state: 'failed' });
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.sendMessage(r.t.id, { text: '@alpha try something else' });
  await sleep(5);
  assert.equal(r.needs(), null);
  work.release();
  await settle(r.rt);
});
