// #466: every exit from waiting on a wake’s own host turn settles the wake, so none is left “running” with no turn
// to settle it, to fire again at the next restart: the agent moved and a turn for it starts elsewhere (leaveMoved),
// the turn given up while it only waits on its resume (cancel), a new turn on the same host instead of the resume
// (allocate), and the attach that finds the host has no record of the turn, whose resume carries the wake. From the
// integrator’s review of #1925.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { rig, starts, startUp, until } from './remote-turns-helpers.mjs';
import { line, moveOff, unreachable, wakeOnHostThenRestart } from './scheduled-wake-host-fixture.mjs';

/** A wake whose host turn is interrupted, waiting on its resume, as when its backend isn’t registered here (#909). */
async function waitingOnResume() {
  const w = await wakeOnHostThenRestart();
  const registered = arrange.withoutAdapters(w.r.rt);
  startUp(w.r);
  await until(() => w.r.se().remoteTurn?.state === 'interrupted', 'the turn to be interrupted, waiting on its resume');
  assert.equal(w.r.store.state.schedules[w.sc.id]?.running, true, 'the wake waits with the resume');
  return { ...w, registered };
}

test('#466 a wake whose host turn waits to be attached retries when a turn for its moved agent starts elsewhere', async () => {
  const { r, sc } = await wakeOnHostThenRestart();
  r.hosts.ensureWelcome = async () => {
    throw unreachable();
  };
  startUp(r);
  await until(() => r.hosts.calls.need.length > 0, 'the host to be needed for the attach');
  moveOff(r);
  // A turn for the moved agent starts on this computer (turn-run.mjs), which stops waiting for the old one.
  r.rt.remote.leaveMoved(r.se().id);
  assert.equal(r.store.state.schedules[sc.id]?.attempt, 1, 'the wake retries where its agent runs now');
  assert.ok(r.rt.timers.has(sc.id), 'its bounded retry is armed');
  assert.equal(line(r, sc).status, 'pending');
  clearTimeout(r.rt.timers.get(sc.id));
});

test('#466 a wake left to its host turn’s resume retries when its agent moves and a turn for it starts elsewhere', async () => {
  const { r, sc, registered } = await waitingOnResume();
  registered();
  moveOff(r);
  // A turn for the moved agent starts on this computer (turn-run.mjs); the resume it waited on won’t carry the wake.
  r.rt.remote.leaveMoved(r.se().id);
  assert.equal(r.store.state.schedules[sc.id]?.attempt, 1, 'the wake retries where its agent runs now');
  assert.ok(r.rt.timers.has(sc.id), 'its bounded retry is armed');
  assert.equal(line(r, sc).status, 'pending');
  clearTimeout(r.rt.timers.get(sc.id));
});

test('#466 a wake left to its host turn’s resume is settled when that turn is given up, not left running', async () => {
  const { r, sc } = await waitingOnResume();
  // Removing the host gives up on the turn, which only waits on its resume now (stopTurnsOn).
  r.rt.remote.cancel(r.se().id);
  assert.equal(r.store.state.schedules[sc.id], undefined, 'no retry onto the host its agent is still placed on');
  assert.equal(line(r, sc).status, 'stopped');
});

test('#466 a wake left to its host turn’s resume is settled when a new turn starts there instead', async () => {
  const { r, sc, d, registered } = await waitingOnResume();
  registered();
  const before = starts(d).length;
  r.rt.sendMessage(r.t.id, { text: 'Something else.' });
  await until(() => starts(d).length === before + 1, 'the new turn to start on the host');
  // Its agent is still placed on that host, so the wake stops rather than retrying beside the new turn.
  assert.equal(r.store.state.schedules[sc.id], undefined, 'the wake isn’t left to a turn that will never run');
  assert.equal(line(r, sc).status, 'stopped');
});

test('#466 a wake whose host turn the host has no record of at a restart is carried by the resume, not stopped', async () => {
  const { r, sc, d, hostTurn } = await wakeOnHostThenRestart();
  // The host’s welcome doesn’t list the turn: it has no record of it, so the attach gives up and the turn resumes.
  const ensure = r.hosts.ensureWelcome;
  let calls = 0;
  r.hosts.ensureWelcome = async (...a) => {
    const w = await ensure(...a);
    return ++calls === 1 ? { ...w, turns: (w.turns ?? []).filter((t) => t.turn !== hostTurn) } : w;
  };
  startUp(r);
  await until(() => starts(d).length === 2, 'the resume to start on the host');
  await until(() => r.store.state.schedules[sc.id]?.turnId === r.se().remoteTurn?.rtTurn, 'the resume to carry the wake');
  assert.equal(r.store.state.schedules[sc.id].running, true);
  d.end(starts(d)[1].turn, { code: 0, signal: null });
  await until(() => line(r, sc).status === 'done', 'the wake to settle as done');
});

test('#466 a wake’s fresh host turn that starts over on a second host turn keeps its wake running, then settles it', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const r = rig({ store: new Store(null), d });
  const sc = r.rt.schedule(r.se().id, { inMs: 60_000, note: 'Check the host.' });
  clearTimeout(r.rt.timers.get(sc.id));
  // Claude Code finds no session to resume, so the turn starts over on a second host turn (nextTurn, allocate again).
  const adapter = r.rt.adapters.get('claude-code');
  const run = adapter.run.bind(adapter);
  let first = true;
  adapter.run = (/** @type {any} */ o) => {
    if (!first) return run(o);
    first = false;
    return Promise.resolve({ missingSession: true });
  };
  fireScheduledWake(r.rt, sc);
  await until(() => starts(d).length === 1, 'the second host turn to start');
  assert.equal(r.store.state.schedules[sc.id]?.running, true, 'its own wake, still running');
  assert.equal(line(r, sc).status, 'running');
  d.end(starts(d)[0].turn, { code: 0, signal: null });
  await until(() => line(r, sc).status === 'done', 'the wake to settle as done');
});

test('#466 a resume whose own start lost the network leaves the wake to the resume that comes once the host is back', async () => {
  const { r, sc, d, hostTurn } = await wakeOnHostThenRestart();
  // The welcome doesn’t list the turn, so the attach gives up and the turn resumes; the resume’s own start then can’t
  // reach the host; later the host is back.
  const ensure = r.hosts.ensureWelcome;
  let calls = 0;
  r.hosts.ensureWelcome = async (...a) => {
    calls++;
    if (calls === 2) throw unreachable();
    const w = await ensure(...a);
    return calls === 1 ? { ...w, turns: (w.turns ?? []).filter((t) => t.turn !== hostTurn) } : w;
  };
  startUp(r);
  await until(() => calls >= 2 && !r.rt.turns.size, 'the resume’s start to fail');
  assert.equal(r.store.state.schedules[sc.id]?.attempt, undefined, 'not retried: the resume to come carries it');
  assert.equal(r.rt.timers.has(sc.id), false);
  r.hosts.emit('status', r.host.id, r.hosts.status(r.host.id));
  await until(() => starts(d).length === 2, 'the resume to start on the host');
  d.end(starts(d)[1].turn, { code: 0, signal: null });
  await until(() => line(r, sc).status === 'done', 'the wake to settle as done');
  await until(() => !r.rt.turns.size && !r.rt.exiting.size, 'the turn to end');
  assert.equal(r.store.state.schedules[sc.id], undefined);
  assert.equal(starts(d).length, 2, 'the wake ran once, through the resume');
});
