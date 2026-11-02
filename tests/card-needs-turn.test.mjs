// Which turn's cards count (#366; the integrator's review of #633, points 1, 2 and 4): answered once,
// in card-needs.mjs, from the session's `lastTurnId` in the store, so a restart keeps it; during a running turn no
// turn-tied card counts, as on main; a card in a side or topic thread is the agent's too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askToWake } from '../server/wake-cards.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, oldSide, settle, sleep } from './side-threads-fixture.mjs';

test('after a restart (the runtime knows no turns), answering a refusal falls back to the last turn’s next refusal', async () => {
  const r = room();
  r.rt.lastTurn?.clear?.(); // what a restart leaves in memory: nothing
  const one = r.denial('one');
  await sleep(2);
  const two = r.denial('two');
  r.setNeed('denial', one.id);
  await r.rt.resolveDenial(r.t.id, one.id, 'leave');
  assert.equal(r.needs()?.itemId, two.id, 'refusal “two”, as main falls back');
});

test('a session from before lastTurnId: the released card’s own turn counts', async () => {
  const r = room();
  r.rt.updateSession(r.alpha.id, { lastTurnId: undefined });
  r.rt.lastTurn?.clear?.();
  const one = r.denial('one', 'turn_old');
  await sleep(2);
  const two = r.denial('two', 'turn_old');
  r.setNeed('denial', one.id);
  await r.rt.resolveDenial(r.t.id, one.id, 'leave');
  assert.equal(r.needs()?.itemId, two.id);
});

test('a permission released during a running turn brings back no block from the turn before (#69), as on main', async () => {
  const r = room();
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await sleep(5);
  r.rt.lastTurn?.set?.(r.alpha.id, 'turn_last'); // the integrator's probe: memory still names the turn before
  r.block(); // open, from turn_last, which this turn moved past
  const p = r.permission();
  r.setNeed('permission', p.id);
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs(), null, 'no need mid-turn');
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'tool', 'and the agent is still working');
  work.release();
  await settle(r.rt);
});

test('a card in a side thread becomes the need and names its thread; one in the conversation names none', async () => {
  const r = room();
  const side = oldSide(r);
  const inSide = r.appCard(side.id);
  const p = r.permission();
  r.setNeed('permission', p.id);
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs()?.itemId, inSide.id);
  assert.equal(r.needs()?.threadId, side.id, '⌃J goes to the side thread');
  r.rt.resolveAppSend(side.id, inSide.id, 'deny');
  const here = r.appCard();
  const p2 = r.permission();
  r.setNeed('permission', p2.id);
  r.rt.settlePermission(p2.id, 'allowed');
  assert.equal(r.needs()?.itemId, here.id);
  assert.equal('threadId' in r.needs(), false, 'a card in the conversation itself names no thread');
});

test('a block in a topic thread off the conversation becomes the need, with the topic’s id', async () => {
  const r = room();
  const root = r.rt.addItem(r.t.id, { kind: 'agent', sessionId: r.alpha.id, handle: 'alpha', text: 'Start here', status: 'done' });
  const { threadId: topic } = r.rt.startTopic(r.t.id, root.id);
  const b = r.block('turn_last', topic);
  const app = r.appCard();
  r.setNeed('appsend', app.id);
  r.rt.resolveAppSend(r.t.id, app.id, 'deny');
  assert.equal(r.needs()?.itemId, b.id);
  assert.equal(r.needs()?.threadId, topic);
  await settle(r.rt);
});

test('a wake request offered while a permission is the need waits behind it, and is the need once the permission is answered', async () => {
  const r = room();
  const p = r.permission();
  r.setNeed('permission', p.id);
  askToWake(r.rt, r.rt.s.sessions[r.alpha.id], r.rt.s.threads[r.t.id], r.b, { text: 'please look' });
  const h = r.rt.store.items(r.t.id).find((x) => x.kind === 'hop');
  assert.equal(r.needs()?.itemId, p.id, 'the permission stays the need');
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs()?.itemId, h.id, 'then the wake request');
});

test('an app card offered while a wake request is the need takes it: same rank, newest first', async () => {
  const r = room();
  const h = r.hop();
  r.setNeed('hop', h.id);
  await sleep(2);
  const card = r.appCard();
  r.rt.needAppSend({ sessionId: r.alpha.id, title: 'App', threadId: r.t.id }, card.id, 1);
  assert.equal(r.needs()?.itemId, card.id);
});

test('a turn’s end records its id on the session, in the store', async () => {
  const r = room();
  r.rt.sendMessage(r.t.id, { text: '@alpha hello' });
  await settle(r.rt);
  const turnId = r.rt.store.items(r.t.id).find((x) => x.kind === 'agent' && x.sessionId === r.alpha.id)?.turnId;
  assert.ok(turnId);
  assert.equal(r.store.state.sessions[r.alpha.id].lastTurnId, turnId);
});

test('a turn that does not move on keeps the block it found, through a permission released mid-turn and at its end', async () => {
  const r = room();
  const b = r.block(); // open, from turn_last
  r.setNeed('block', b.id);
  const work = held();
  r.adapter.next.push(work.step);
  r.rt.deliver(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' }); // another agent's wake
  await sleep(5);
  const p = r.permission();
  r.setNeed('permission', p.id);
  r.rt.settlePermission(p.id, 'allowed');
  assert.equal(r.needs()?.itemId, b.id, 'the block is the need again once the permission is answered');
  work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, b.id, 'and still at the turn’s end');
});

test('an app check’s note after the turn ended is scoped to the session’s lastTurnId, the second reader', async () => {
  const r = room();
  r.adapter.next.push(async (c, _m, se) => {
    r.rt.toolsFor(se.id).show_app({ id: 'lab', title: 'Lab', code: '<p>Lab</p>' });
    c.text('Here it is.');
  });
  r.rt.sendMessage(r.t.id, { text: '@alpha make an app' });
  await settle(r.rt);
  const scoped = [];
  r.rt.lint = (sessionId, turnId) => scoped.push({ sessionId, turnId });
  r.rt.appCheck('lab', { version: 1, problems: [{ code: 'marks-too-small', message: 'Tiny marks.' }] });
  assert.deepEqual(scoped, [{ sessionId: r.alpha.id, turnId: r.store.state.sessions[r.alpha.id].lastTurnId }]);
  assert.ok(scoped[0].turnId);
});
