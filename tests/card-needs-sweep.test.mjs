// The restart sweep's own rules (#366; critic's review of #633 at e776d4b0, the mutants that passed every spec): a need
// is kept only while its card still waits, and on a tie the newer card takes it, as nextNeed and the turn's end choose.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { settleOrphanTurns } from '../server/store-outage.mjs';
import { room } from './card-needs-fixture.mjs';

/** The store as a restart finds it: @alpha was mid-turn with `needs` set, and the sweep runs on the new runtime's view. */
function cutOff(r, needs) {
  r.rt.updateSession(r.alpha.id, { needs, state: 'tool' });
  settleInterrupted(r.rt);
  return r.rt.s.sessions[r.alpha.id];
}

test('a block you answered before the restart is no longer the need', () => {
  const r = room();
  const b = r.block();
  r.rt.patchItem(r.t.id, b.id, { answered: { action: 'choose' } });
  const se = cutOff(r, { kind: 'block', itemId: b.id, text: 'Pick' });
  assert.equal(se.needs, null);
  assert.equal(se.state, 'idle');
});

test('a need whose card is gone is dropped, not kept', () => {
  const r = room();
  const se = cutOff(r, { kind: 'appsend', itemId: 'it_gone', text: 'App' });
  assert.equal(se.needs, null);
});

test('a block still open stays the need', () => {
  const r = room();
  const b = r.block();
  const se = cutOff(r, { kind: 'block', itemId: b.id, text: 'Pick' });
  assert.equal(se.needs?.itemId, b.id);
  assert.equal(se.state, 'needs');
});

test('on a tie, the newer card takes the need, as nextNeed and the turn’s end choose', () => {
  const r = room();
  const older = r.denial('ls');
  const newer = r.denial('pwd');
  r.rt.patchItem(r.t.id, newer.id, { at: (older.at ?? 0) + 1 });
  const se = cutOff(r, { kind: 'denial', itemId: older.id, text: 'A step was refused: ls' });
  assert.equal(se.needs?.itemId, newer.id);
});

test('a block still open stays the need even when its turn no longer counts, as main keeps it', () => {
  const r = room();
  const b = r.block('turn_old');
  const se = cutOff(r, { kind: 'block', itemId: b.id, text: 'Pick' });
  assert.equal(se.needs?.itemId, b.id);
});

test('a Store Retry that finds the agent mid-turn with no turn running settles its need as a restart does', () => {
  const r = room();
  const b = r.block();
  r.rt.patchItem(r.t.id, b.id, { answered: { action: 'choose' } });
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'block', itemId: b.id, text: 'Pick' }, state: 'tool' });
  settleOrphanTurns(r.rt);
  assert.equal(r.needs(), null, 'the answered block isn’t kept');
  const card = r.appCard();
  r.rt.updateSession(r.alpha.id, { needs: { kind: 'appsend', itemId: card.id, text: 'App' }, state: 'tool' });
  settleOrphanTurns(r.rt);
  const se = r.rt.s.sessions[r.alpha.id];
  assert.equal(se.needs?.itemId, card.id, 'the app card still waits');
  assert.equal(se.state, 'needs', 'and the ring says so, not idle');
});

test('a card in a topic of another conversation is never this agent’s need', () => {
  const r = room();
  r.rt.putThread({ id: 'th_elsewhere', kind: 'conversation', title: 'Other', members: [], createdAt: 0 });
  r.rt.putThread({ id: 'th_other_topic', kind: 'topic', parentId: 'th_elsewhere', title: 'T', members: [], createdAt: 0 });
  r.appCard('th_other_topic');
  const se = cutOff(r, null);
  assert.equal(se.needs, null);
});

test('on a tie the sweep compares the cards’ times: a newer need nextNeed doesn’t count isn’t replaced by an older card', () => {
  const r = room();
  const older = r.denial('ls'); // from turn_last: nextNeed counts it
  const newer = r.denial('pwd', 'turn_other'); // a turn that no longer counts, but its card waits
  r.rt.patchItem(r.t.id, newer.id, { at: (older.at ?? 0) + 1 });
  const se = cutOff(r, { kind: 'denial', itemId: newer.id, text: 'A step was refused: pwd' });
  assert.equal(se.needs?.itemId, newer.id);
});

test('on a tie of the same time, the card nextNeed found wins, as within nextNeed', () => {
  const r = room();
  const first = r.block();
  const second = r.block();
  r.rt.patchItem(r.t.id, second.id, { at: first.at });
  const se = cutOff(r, { kind: 'block', itemId: first.id, text: 'Pick' });
  assert.equal(se.needs?.itemId, second.id);
});
