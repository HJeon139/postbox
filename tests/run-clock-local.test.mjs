// A run clock’s stop of a turn on this computer (server/run-clock.mjs, server/turn-stop.mjs): Stop sends the CLI’s
// group SIGINT, and the turn ends only once the group has exited, after up to its grace period and SIGKILL
// (server/adapters/process-group.mjs), so the agent may go on working meanwhile (hydrant-critic’s review of #1522). A
// pause or expiry lists the turn as still to stop, and its exit records clock.stopped, as a host’s confirmation does
// for a turn there (tests/run-clock-remote.test.mjs). The turns are the Stop tests’ scripted adapter, which exits only
// when the test says (slowToExit). No real timer runs: mock timers stand in for setTimeout, setInterval and Date.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { clockAction } from '../server/run-clock.mjs';
import { clockElapsed } from '../shared/run-clock.mjs';
import { EVENTS } from '../shared/state.mjs';
import { trajectories } from '../tools/atif.mjs';
import { setup, slowToExit } from './stop-fixture.mjs';

const T0 = 1_800_000_000_000;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());
const at = (ms) => () => T0 + ms;
/** Lets the scripted turns settle on the event loop’s turns, with no time passing. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const clockEvents = (store) => store.since(0).filter((e) => e.type.startsWith('clock.'));

/** A clocked agent with a turn running that, once stopped, exits only when the test calls exit(). */
async function working() {
  const f = setup();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 60 }); // at T0, by the mock clock
  const turn = slowToExit();
  f.adapter.next.push(turn);
  f.rt.sendMessage(f.t.id, { text: 'Work until stopped.' });
  await settle();
  assert.ok(f.rt.turns.has(f.se.id));
  const turnId = f.rt.turns.get(f.se.id).id;
  return { ...f, turn, stopId: `turn:${turnId}`, clock: () => f.store.state.clocks[f.se.id] };
}

test('a pause counts on while the stopped CLI is still exiting, and stops counting when it has exited', async () => {
  const { rt, store, se, turn, stopId, clock } = await working();
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  assert.ok(rt.exiting.has(se.id), 'stopped, and still exiting');
  assert.deepEqual(clockEvents(store).find((e) => e.type === 'clock.paused').data.stopping, [stopId]);
  assert.equal(clockElapsed(clock(), T0 + 12_000), 12_000, 'the agent may still be working');
  assert.throws(
    () => clockAction(rt, se.id, { action: 'resume' }, at(12_000)),
    (e) => e.status === 409,
  );
  mock.timers.setTime(T0 + 13_000);
  turn.exit();
  await settle();
  assert.deepEqual(clockEvents(store).find((e) => e.type === 'clock.stopped').data, { sessionId: se.id, turn: stopId, at: T0 + 13_000 });
  assert.equal(clockElapsed(clock(), T0 + 90_000), 13_000, 'counted to the exit, and no further');
  clockAction(rt, se.id, { action: 'resume' }, at(20_000));
  assert.equal(clock().state, 'running');
});

test('an expiry lists the CLI still exiting, and the export says when it exited', async () => {
  const { store, se, turn, stopId } = await working();
  mock.timers.tick(60_000); // the clock’s own timer, at its budget
  await settle();
  assert.equal(store.state.clocks[se.id].state, 'expired');
  mock.timers.tick(2_500);
  turn.exit();
  await settle();
  const t = trajectories(
    store.since(0).filter((e) => EVENTS[e.type]?.public),
    { version: '0' },
  ).find((x) => x.sessionId === se.id).trajectory;
  assert.deepEqual(t.extra.stops, [
    {
      turn: stopId,
      where: 'local',
      asked_by: 'clock.expired',
      asked_at: new Date(T0 + 60_000).toISOString(),
      confirmed_at: new Date(T0 + 62_500).toISOString(),
    },
  ]);
  assert.match(t.notes, /^Partial: Postbox stopped the agent’s turn once, and records nothing it did until the turn ended: /);
});

test('a CLI that hasn’t exited when Stop’s watchdog gives up is recorded as stopped by force, not as exited', async () => {
  const { rt, store, se, stopId } = await working();
  clockAction(rt, se.id, { action: 'pause' }, at(10_000));
  // The watchdog lets the next turn start after 15 s without an exit (server/turn-stop.mjs, STOP_WATCHDOG_MS).
  mock.timers.tick(15_000);
  await settle();
  const stopped = clockEvents(store).find((e) => e.type === 'clock.stopped');
  assert.deepEqual(stopped?.data, { sessionId: se.id, turn: stopId, forced: true, why: 'watchdog', at: T0 + 15_000 });
});
