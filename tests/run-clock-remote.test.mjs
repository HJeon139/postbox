// A run clock’s stop of a turn on a host (server/run-clock.mjs, server/remote/turns-stops.mjs): Postbox asks the host
// to stop it, and the turn may run on there until the daemon confirms (#120), as when the link is down at the budget
// (hydrant-critic’s review of #1522). The clock records which host turns it asked to stop, a paused clock counts on
// until they’ve stopped, and clock.stopped records each confirmation. The host is tests/remote-turns-helpers.mjs’s
// fake daemon and link. No real timer runs: mock timers stand in for setTimeout, setInterval and Date, and each wait
// is on the event loop’s turns, never on time.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { clockElapsed } from '../shared/run-clock.mjs';
import { EVENTS } from '../shared/state.mjs';
import { trajectories } from '../tools/atif.mjs';
import { clockTimer, runClock } from './arrange.mjs';
import { rig, starts } from './remote-turns-helpers.mjs';

const T0 = 1_800_000_000_000;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());
const at = (ms) => () => T0 + ms;
/** Waits on the event loop’s turns, not on time, until `fn` holds. */
async function until(fn, label) {
  for (let i = 0; i < 2000 && !fn(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(fn(), `Timed out waiting for ${label}`);
}
const clockEvents = (r) => r.store.since(0).filter((e) => e.type.startsWith('clock.'));

/** A clocked agent’s turn running on the host, with its link then down: a stop can’t reach the daemon. */
async function cutOff(budgetS = 60) {
  const r = rig();
  // The fake host manager’s wait for a welcome, polled on the event loop’s turns rather than on its sleep(2).
  r.hosts.ensureWelcome = async () => {
    r.hosts.calls.ensure++;
    await until(() => r.link.connected, 'a welcome from the fake daemon');
    return r.link.welcome;
  };
  const id = r.se().id;
  runClock(r.rt, id, { action: 'start', budgetS }, at(0));
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => starts(r.d).length === 1 && r.d.turns.has(starts(r.d)[0].turn), 'the turn on the host');
  const turn = starts(r.d)[0].turn;
  await until(() => r.d.received.some((m) => m.type === 'read' && m.turn === turn), 'the turn to be read');
  r.link.giveUp();
  return { r, id, turn, clock: () => r.store.state.clocks[id] };
}

test('at the budget, a turn on a host that can’t be reached is asked to stop, and the clock says it hasn’t until the host confirms', async () => {
  const { r: rr, id: sid, turn: hostTurn, clock: c } = await cutOff();
  clockTimer(rr.rt, sid, at(60_000));
  const expired = clockEvents(rr).find((e) => e.type === 'clock.expired');
  assert.deepEqual(expired.data.stopping, [hostTurn], 'the stop it asked and the host hasn’t confirmed');
  assert.deepEqual(c().stopping, [hostTurn]);
  assert.equal(rr.d.turns.get(hostTurn).exit, null, 'the turn runs on there');
  assert.equal(
    clockEvents(rr).some((e) => e.type === 'clock.stopped'),
    false,
  );
  // Back: the stop goes at the welcome, the daemon confirms it, and the clock records when.
  mock.timers.setTime(T0 + 95_000);
  rr.link.reconnect();
  await until(() => clockEvents(rr).some((e) => e.type === 'clock.stopped'), 'the confirmation');
  const stopped = clockEvents(rr).find((e) => e.type === 'clock.stopped');
  assert.deepEqual(stopped.data, { sessionId: sid, turn: hostTurn, at: T0 + 95_000 });
  assert.deepEqual(c().stopping, []);
  assert.equal(c().state, 'expired');
});

test('a pause counts on until the host confirms its turn stopped, and only then stops counting', async () => {
  const { r, id, turn, clock } = await cutOff();
  runClock(r.rt, id, { action: 'pause' }, at(10_000));
  assert.equal(clock().state, 'paused', 'no turn starts meanwhile');
  assert.deepEqual(clock().stopping, [turn]);
  assert.equal(clockElapsed(clock(), T0 + 30_000), 30_000, 'the agent may still be working on its host');
  mock.timers.setTime(T0 + 40_000);
  r.link.reconnect();
  await until(() => clock().stopping.length === 0, 'the confirmation');
  assert.equal(clockElapsed(clock(), T0 + 90_000), 40_000, 'counted to the confirmation, and no further');
  assert.equal(clock().state, 'paused');
});

test('a pause whose stop the host hasn’t confirmed still expires at the budget', async () => {
  const { r, id, turn, clock } = await cutOff();
  runClock(r.rt, id, { action: 'pause' }, at(10_000));
  clockTimer(r.rt, id, at(60_000));
  assert.equal(clock().state, 'expired');
  assert.deepEqual(clockEvents(r).find((e) => e.type === 'clock.expired').data.stopping, [turn]);
});

/** The trajectory of the agent from what the server recorded, as /api/stream sends it: its public events. */
const exported = (r) =>
  trajectories(
    r.store.since(0).filter((e) => EVENTS[e.type]?.public),
    { version: '0' },
  ).find((x) => x.sessionId === r.se().id).trajectory;

test('an export says the trajectory is partial from the stop Postbox asked of the host until the host confirmed it', async () => {
  const { r, turn } = await cutOff();
  clockTimer(r.rt, r.se().id, at(60_000));
  const before = exported(r);
  assert.match(
    before.notes,
    /^Partial: Postbox asked the agent’s host to stop its turn once, and records nothing the turn did until the host confirmed: .*never confirmed/,
  );
  assert.deepEqual(before.extra.remote_stops, [{ turn, asked_by: 'clock.expired', asked_at: new Date(T0 + 60_000).toISOString(), confirmed_at: null }]);
  assert.match(before.steps.find((s) => s.extra.event === 'clock.expired').message, /asked the agent’s host to stop it, which the host hadn’t confirmed yet/);
  mock.timers.setTime(T0 + 95_000);
  r.link.reconnect();
  await until(() => r.store.state.clocks[r.se().id].stopping.length === 0, 'the confirmation');
  const after = exported(r);
  assert.equal(after.extra.remote_stops[0].confirmed_at, new Date(T0 + 95_000).toISOString());
  assert.match(after.notes, /until its host confirmed the stop 35\.000s later/);
  assert.equal(after.steps.at(-1).extra.event, 'clock.stopped');
});
