// A run clock’s stop that Postbox can’t confirm took effect (hydrant-critic’s review of #1522): a CLI whose group
// outlives SIGKILL (server/adapters/process-group.mjs gives up on it), one Stop’s watchdog stops waiting for
// (server/turn-stop.mjs), and a local stop a restart finds still listed. The agent may still be working, uncounted,
// so the clock ends the timed run as void: clock.stopped says forced and why, the clock expires with `voided`, and no
// turn of the agent starts again. The turns are the Stop tests’ scripted adapter (tests/stop-fixture.mjs). No real
// timer runs: mock timers stand in for setTimeout, setInterval and Date.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { stopTurn } from '../server/adapters/process-group.mjs';
import { clockAction, rearmClocks } from '../server/run-clock.mjs';
import { CLOCK_WORDS, clockStops, stopsScope } from '../tools/atif-clock.mjs';
import { setup } from './stop-fixture.mjs';

const T0 = 1_800_000_000_000;
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }));
afterEach(() => mock.timers.reset());
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const stoppedOf = (store) => store.since(0).find((e) => e.type === 'clock.stopped')?.data;

test('stopTurn says so when the CLI’s group outlives SIGKILL and it gives up waiting, and not when the group exits', async () => {
  const alive = () => true; // every signal lands, and signal 0 finds the group there
  const unkilled = [];
  const { gone } = await stopTurn(
    { pid: 5151 },
    { exited: Promise.resolve(), kill: alive, list: async () => [], graceMs: 3000, unkilled: () => unkilled.push('x') },
  );
  mock.timers.tick(8000);
  await gone;
  assert.deepEqual(unkilled, ['x']);
  const gone2 = new Set();
  const dies = (pid, sig) => {
    if (sig === 0 && gone2.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    if (sig === 'SIGKILL') gone2.add(pid);
    return true;
  };
  const again = [];
  const r = await stopTurn(
    { pid: 5252 },
    { exited: Promise.resolve(), kill: dies, list: async () => [], graceMs: 3000, pollMs: 100, unkilled: () => again.push('x') },
  );
  mock.timers.tick(3100);
  await r.gone;
  assert.deepEqual(again, []);
});

/** A clocked agent whose turn, once stopped, exits only when the test says, telling Postbox first if asked to. */
async function working({ unkilled = false } = {}) {
  const f = setup();
  clockAction(f.rt, f.se.id, { action: 'start', budgetS: 60 });
  let exit = () => {};
  const exited = new Promise((r) => {
    exit = r;
  });
  f.adapter.next.push(async (c) => {
    c.text('working');
    await new Promise((r) => c.signal.addEventListener('abort', r));
    if (unkilled) c.unkilled();
    await exited;
  });
  f.rt.sendMessage(f.t.id, { text: 'Work until stopped.' });
  await settle();
  return { ...f, exit, turnId: f.rt.turns.get(f.se.id).id, clock: () => f.store.state.clocks[f.se.id] };
}

test('when Stop’s watchdog gives up on a paused turn’s CLI, the run is void and no turn of the agent starts again', async () => {
  const { rt, store, se, t, adapter, turnId, clock } = await working();
  clockAction(rt, se.id, { action: 'pause' }, () => T0 + 10_000);
  mock.timers.tick(15_000);
  await settle();
  assert.deepEqual(stoppedOf(store), { sessionId: se.id, turn: `turn:${turnId}`, forced: true, why: 'watchdog', at: T0 + 15_000 });
  assert.equal(clock().state, 'expired');
  assert.deepEqual(clock().voided, { why: 'watchdog', at: T0 + 15_000 });
  assert.deepEqual(clock().stopping, []);
  assert.throws(
    () => clockAction(rt, se.id, { action: 'resume' }),
    (e) => e.status === 409,
  );
  const calls = adapter.calls.length;
  rt.sendMessage(t.id, { text: 'Go on.' });
  await settle();
  assert.equal(adapter.calls.length, calls, 'no new turn beside a CLI that may still be working');
  assert.match(store.items(t.id).findLast((i) => i.variant === 'clock').text, /timed run is void/);
});

test('a turn whose adapter says its CLI outlived SIGKILL ends the run as void when the turn ends', async () => {
  const { rt, store, se, exit, turnId, clock } = await working({ unkilled: true });
  clockAction(rt, se.id, { action: 'pause' }, () => T0 + 10_000);
  await settle();
  mock.timers.setTime(T0 + 18_000);
  exit();
  await settle();
  assert.deepEqual(stoppedOf(store), { sessionId: se.id, turn: `turn:${turnId}`, forced: true, why: 'unkilled', at: T0 + 18_000 });
  assert.equal(clock().state, 'expired');
});

test('a local stop a restart finds still listed ends the run as void, since no one can say when it ended', () => {
  const { rt, store, se } = setup();
  clockAction(rt, se.id, { action: 'start', budgetS: 60 });
  // As the store holds it after a crash: paused, with a local turn still to stop, and no clock.stopped.
  store.emit('clock.paused', { sessionId: se.id, stopping: ['turn:turn_gone'], at: T0 + 10_000 });
  rearmClocks(rt, () => T0 + 30_000);
  assert.deepEqual(stoppedOf(store), { sessionId: se.id, turn: 'turn:turn_gone', forced: true, why: 'restart', at: T0 + 30_000 });
  assert.equal(store.state.clocks[se.id].state, 'expired');
});

test('the export says a forced stop voids the run, a local expiry that the turn may outlive, and mixed stops by where', () => {
  const sessionId = 'se_1';
  const clocks = [
    { type: 'clock.paused', data: { sessionId, stopping: ['turn:turn_1'], at: T0 + 10_000 } },
    { type: 'clock.stopped', data: { sessionId, turn: 'turn:turn_1', at: T0 + 11_000 } },
    { type: 'clock.resumed', data: { sessionId, at: T0 + 20_000 } },
    { type: 'clock.expired', data: { sessionId, elapsedMs: 60_000, budgetMs: 60_000, stopping: ['host-turn-9'], at: T0 + 70_000 } },
    { type: 'clock.stopped', data: { sessionId, turn: 'host-turn-9', at: T0 + 71_000 } },
  ];
  const mixed = stopsScope(clockStops(clocks)).note;
  assert.match(mixed, /^Partial: Postbox stopped the agent’s turn 2 times \(once on this computer, once on its host\)/);
  assert.match(
    CLOCK_WORDS['clock.expired']({ budgetMs: 60_000, stopping: ['turn:turn_1'] }),
    /stopped the agent’s turn, which may run on until its CLI has exited/,
  );
  const forced = stopsScope(
    clockStops([
      { type: 'clock.paused', data: { sessionId, stopping: ['turn:turn_1'], at: T0 + 10_000 } },
      { type: 'clock.stopped', data: { sessionId, turn: 'turn:turn_1', forced: true, why: 'watchdog', at: T0 + 25_000 } },
    ]),
  );
  assert.match(forced.note, /^Void as a timed run: /);
  assert.deepEqual(forced.extra.clock_void, { why: 'watchdog', at: new Date(T0 + 25_000).toISOString() });
});
