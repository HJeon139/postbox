// A host turn from before a restart, attached again while its agent’s run clock holds it (#1526, the integrator’s P1-a
// on #1522): the clock ran out while Postbox was down, or was paused while the turn waited to be attached. The turn may
// be working on its host, so the clock lists it as still to stop, and Postbox asks its host to stop it once the
// attach has made its remote turn; the host’s confirmation records clock.stopped. The host is
// tests/remote-turns-helpers.mjs’s fake daemon and link. No real timer runs: mock timers stand in for setTimeout,
// setInterval and Date, and each wait is on the event loop’s turns, never on time.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { installRunClock } from '../server/run-clock-install.mjs';
import { clockElapsed } from '../shared/run-clock.mjs';
import { runClock } from './arrange.mjs';
import { until } from './event-loop-until.mjs';
import { restarted, rig, startUp } from './remote-turns-helpers.mjs';

const T0 = 1_800_000_000_000;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());

/** The store a restart finds: a turn on the host from before it, and its agent’s clock started at T0. */
function clockedBeforeRestart(budgetS) {
  const { store, d } = restarted({ welcome: 'running' });
  const se = Object.values(store.state.sessions).find((s) => s.remoteTurn);
  store.emit('clock.started', { sessionId: se.id, threadId: se.threadId, budgetMs: budgetS * 1000, at: T0 });
  return { store, d, id: se.id };
}

test('a clock that ran out while Postbox was down lists the host turn, and the attach asks the host to stop it', async () => {
  const { store, d, id } = clockedBeforeRestart(60);
  mock.timers.setTime(T0 + 90_000);
  const r = rig({ store, d });
  // The fake host manager’s wait for a welcome, polled on the event loop’s turns rather than on its sleep(2).
  r.hosts.ensureWelcome = async () => {
    await until(() => r.link.connected, 'a welcome from the fake daemon');
    return r.link.welcome;
  };
  installRunClock(r.rt); // as server/index.mjs does, before the hosts start
  const clock = () => r.store.state.clocks[id];
  assert.equal(clock().state, 'expired');
  assert.deepEqual(clock().stopping, ['host-turn-1'], 'the turn may be working on its host');
  startUp(r);
  await until(() => d.stops.includes('host-turn-1'), 'the stop to reach the host');
  await until(() => clock().stopping.length === 0, 'the host’s confirmation');
  const stopped = r.store.since(0).find((e) => e.type === 'clock.stopped');
  assert.deepEqual(stopped.data, { sessionId: id, turn: 'host-turn-1', at: T0 + 90_000 });
  assert.equal(r.rt.turns.has(id), false, 'no turn of the agent runs');
});

test('a pause while the turn waits to be attached counts on, and its attach is stopped, so the resume waits for the host', async () => {
  const { store, d, id } = clockedBeforeRestart(600);
  const r = rig({ store, d });
  // The host can’t be reached as Postbox starts again: no welcome comes until the test lets it.
  let back;
  const isBack = new Promise((resolve) => {
    back = resolve;
  });
  r.hosts.ensureWelcome = async () => {
    await isBack;
    return r.link.welcome;
  };
  installRunClock(r.rt);
  startUp(r);
  await until(() => r.rt.running.awaitsAttach(id), 'the turn waiting to be attached');
  runClock(r.rt, id, { action: 'pause' }, () => T0 + 10_000);
  const clock = () => r.store.state.clocks[id];
  assert.deepEqual(clock().stopping, ['host-turn-1'], 'the turn may be working on its host');
  assert.equal(clockElapsed(clock(), T0 + 30_000), 30_000, 'so the clock counts on');
  assert.throws(
    () => runClock(r.rt, id, { action: 'resume' }, () => T0 + 20_000),
    (e) => e.status === 409,
  );
  // The host is back: the turn is attached, and stopped once its remote turn is made.
  mock.timers.setTime(T0 + 40_000);
  await until(() => r.link.connected, 'a welcome from the fake daemon');
  back();
  await until(() => d.stops.includes('host-turn-1'), 'the stop to reach the host');
  await until(() => clock().stopping.length === 0, 'the host’s confirmation');
  assert.equal(clockElapsed(clock(), T0 + 90_000), 40_000, 'counted to the confirmation, and no further');
  await until(() => !r.rt.turns.has(id) && !r.rt.exiting.has(id), 'the attached turn to end here');
  runClock(r.rt, id, { action: 'resume' }, () => T0 + 50_000);
  assert.equal(clock().state, 'running');
});

test('a turn the host no longer has, once its welcome comes, ends in the clock’s list of turns still to stop', async () => {
  const { store, d, id } = clockedBeforeRestart(60);
  d.turns.delete('host-turn-1'); // gone from the host while Postbox was down
  mock.timers.setTime(T0 + 90_000);
  const r = rig({ store, d });
  r.hosts.ensureWelcome = async () => {
    await until(() => r.link.connected, 'a welcome from the fake daemon');
    return r.link.welcome;
  };
  installRunClock(r.rt);
  const clock = () => r.store.state.clocks[id];
  assert.deepEqual(clock().stopping, ['host-turn-1']);
  startUp(r);
  await until(() => clock().stopping.length === 0, 'the welcome to say it’s gone');
  assert.deepEqual(r.store.since(0).find((e) => e.type === 'clock.stopped').data, { sessionId: id, turn: 'host-turn-1', at: T0 + 90_000 });
  assert.equal(d.stops.length, 0, 'no stop for a turn the host doesn’t have');
});
