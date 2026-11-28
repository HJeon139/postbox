// A turn a run clock stopped says so, not “Stopped by you” (#1526, the integrator’s P2 on #1522): its reply’s
// stopReason is the clock’s expiry or its pause, which app/js/reply-stop.mjs tags in its own words
// (tests/browser/run-clock.spec.mjs), and so is the session’s line once the turn has exited. The turns are the Stop
// tests’ scripted adapter. No real timer runs: mock timers stand in for setTimeout, setInterval and Date.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { clockAction } from '../server/run-clock.mjs';
import { clocked } from './run-clock-fixture.mjs';
import { slowToExit } from './stop-fixture.mjs';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 }));
afterEach(() => mock.timers.reset());
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A clocked agent’s turn, running, which exits once stopped. */
async function working() {
  const f = clocked();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 60 });
  const turn = slowToExit();
  f.adapter.next.push(turn);
  f.rt.sendMessage(f.t.id, { text: 'Work until stopped.' });
  await settle();
  return { ...f, turn, reply: () => f.store.items(f.t.id).findLast((i) => i.kind === 'agent') };
}

test('a turn the clock’s budget stopped is the clock’s stop, in its reply and in the session’s line', async () => {
  const { store, se, turn, reply } = await working();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(reply().status, 'stopped');
  assert.equal(reply().stopReason, 'clock');
  turn.exit();
  await settle();
  assert.equal(store.state.sessions[se.id].currentStep, 'Stopped: its run clock reached its budget');
});

test('a turn the clock’s pause stopped is the pause’s stop, in its reply and in the session’s line', async () => {
  const { rt, store, se, turn, reply } = await working();
  clockAction(rt, se.id, { action: 'pause' });
  await settle();
  assert.equal(reply().stopReason, 'pause');
  turn.exit();
  await settle();
  assert.equal(store.state.sessions[se.id].currentStep, 'Stopped: its run clock is paused');
});

test('the person’s own Stop is still theirs', async () => {
  const { rt, store, se, turn, reply } = await working();
  rt.stop(se.id, { by: 'you' });
  turn.exit();
  await settle();
  assert.equal(reply().stopReason, 'stop');
  assert.equal(store.state.sessions[se.id].currentStep, 'Stopped by you');
});
