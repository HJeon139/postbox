// #466: every exit from waiting on a wake’s own host turn settles the wake, so none is left “running” with no turn
// to settle it, to fire again at the next restart: the agent moved and a turn for it starts elsewhere (leaveMoved),
// the turn given up while it only waits on its resume (cancel), a new turn on the same host instead of the resume
// (allocate), and the attach that finds the host has no record of the turn, whose resume carries the wake. From the
// integrator’s review of #1925.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { starts, startUp, until } from './remote-turns-helpers.mjs';
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
  assert.notEqual(r.store.state.schedules[sc.id]?.running, true, 'the wake isn’t left to a turn that will never run');
  assert.notEqual(line(r, sc).status, 'running');
  assert.equal(starts(d).length, before + 1, 'the wake didn’t start a turn of its own beside the new one');
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
