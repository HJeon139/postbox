// The restart sweep's own rules (#366; critic's review of #633 at e776d4b0, the mutants that passed every spec): a need
// is kept only while its card still waits, and on a tie the newer card takes it, as nextNeed and the turn's end choose.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleInterrupted } from '../server/restart-sweep.mjs';
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
