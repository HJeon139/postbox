// marker-before-output (#508, server/room-checks-delivery.mjs): a session’s catch-up marker moved for a turn that then
// produced no output (DL-3). The rooms are hand-built from the shapes UAT runs record (tests/delivery-fixture.mjs says
// why, and which). Moved from tests/uat-checks-delivery.test.mjs for size.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

/** @researcher’s marker moves as its turn’s prompt is built; the turn then writes something, or nothing. */
function markerRoom({ output }) {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_a', at: s(1), kind: 'user', text: 'First message' });
  r.marker('researcher', null, s(0));
  r.marker('researcher', 'it_a', s(10));
  r.turn('researcher', s(10) + 3, { prompt: 'First message', output });
  return r.f;
}

test('marker-before-output fires when the marker moved for a turn that wrote nothing', () => {
  // Cut after its init, as tools/uat/fault-launcher.mjs cuts a turn: no recorded failing turn exists yet.
  const out = found(markerRoom({ output: false }), 'marker-before-output');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /from the start to it_a/);
  assert.deepEqual(out[0].requirements, ['DL-3', 'INV-6']);
});

test('marker-before-output stays silent when the turn the marker moved for wrote something', () => {
  assert.deepEqual(found(markerRoom({ output: true }), 'marker-before-output'), []);
});
