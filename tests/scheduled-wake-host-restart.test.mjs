// #466: a scheduled wake whose own turn is on a host at a restart stays that turn’s. The turn attached again carries
// the wake (its origin record keeps scheduledWakeId), so it settles the wake as the first turn would have: done when
// it ends, retried with the bounded backoff on a network failure. When Postbox gives up attaching it, the wake’s line
// never says “done”: an agent moved off that host has its wake retried where it runs now, and one still placed on a
// host Postbox can’t reach any more has it stopped, since a retry could only fail there.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failure } from '../server/remote/ssh-failures.mjs';
import { fireScheduledWake, rearmWakes } from '../server/scheduled-wakes.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { HOST, rig, running, starts, startUp, until } from './remote-turns-helpers.mjs';

const unreachable = () => failure('unreachable', HOST, { code: 255, stderr: `ssh: connect to host ${HOST} port 22: Network is unreachable` });

/** A wake whose own turn runs on the host, then Postbox stops with it still there and starts again on the same store. */
async function wakeOnHostThenRestart({ removeHost = false } = {}) {
  const d = createFakeDaemon({ autoEnd: false });
  const first = rig({ store: new Store(null), d });
  const sc = first.rt.schedule(first.se().id, { inMs: 60_000, note: 'Check the host.' });
  clearTimeout(first.rt.timers.get(sc.id));
  fireScheduledWake(first.rt, sc);
  await until(() => starts(d).length === 1, 'the wake’s turn to start on the host');
  await until(() => first.store.state.schedules[sc.id]?.turnId === first.se().remoteTurn?.rtTurn, 'the schedule to name its turn');
  const hostTurn = starts(d)[0].turn;
  first.rt.remote.close();
  d.drop();
  d.connect();
  const r = rig({ store: first.store, d });
  // The host removed while Postbox was down (after the rig, which would add one again): Postbox can’t reach it any more.
  if (removeHost) r.store.emit('host', { id: r.host.id, removed: true });
  // server/index.mjs’s order: the schedules are re-armed, then the host turns restored.
  rearmWakes(r.rt);
  return { r, sc, d, hostTurn };
}

const line = (r, sc) => r.store.item(sc.threadId, sc.itemId);
/** The agent moved off its host, to run on this computer. @param {any} r */
const moveOff = (r) => {
  const p = r.rt.personas.forSession(r.se());
  r.store.emit('persona', { ...p, remote: null });
};

test('#466 a wake’s host turn attached again after a restart settles the wake when it ends, not at the restart', async () => {
  const { r, sc, d, hostTurn } = await wakeOnHostThenRestart();
  assert.notEqual(line(r, sc).status, 'done', 'the line doesn’t say done while its turn still runs on the host');
  startUp(r);
  await until(() => r.rt.turns.size === 1, 'the turn to be attached again');
  assert.equal(r.rt.turns.get(r.se().id).asked.message?.scheduledWakeId, sc.id, 'the attached turn carries the wake');
  d.end(hostTurn, { code: 0, signal: null });
  await until(() => line(r, sc).status === 'done', 'the wake to settle as done');
  assert.equal(r.store.state.schedules[sc.id], undefined);
  assert.equal(r.rt.timers.has(sc.id), false);
});

test('#466 a network failure in a wake’s host turn attached again after a restart retries the wake', async () => {
  const { r, sc } = await wakeOnHostThenRestart();
  // The restore’s welcome comes; the link is gone again by the time the attached turn asks for its own.
  const ensure = r.hosts.ensureWelcome;
  let calls = 0;
  r.hosts.ensureWelcome = async (...a) => {
    if (++calls === 2) throw unreachable();
    return ensure(...a);
  };
  startUp(r);
  await until(() => r.store.state.schedules[sc.id]?.attempt === 1, 'the wake’s retry');
  const retry = r.store.state.schedules[sc.id];
  assert.equal(retry.running, false);
  assert.ok(r.rt.timers.has(sc.id), 'its bounded retry is armed');
  assert.equal(line(r, sc).status, 'pending');
  assert.equal(line(r, sc).retryAttempt, 1);
  clearTimeout(r.rt.timers.get(sc.id));
});

test('#466 a second restart during a wake’s host turn attached again leaves the wake to that turn', async () => {
  const first = await wakeOnHostThenRestart();
  startUp(first.r);
  await until(() => first.r.rt.turns.size === 1, 'the turn to be attached again');
  const attached = first.r.rt.turns.get(first.r.se().id).id;
  await until(() => first.r.se().remoteTurn?.rtTurn === attached, 'the attach to be recorded');
  first.r.rt.remote.close();
  first.d.drop();
  first.d.connect();
  const again = rig({ store: first.r.store, d: first.d });
  rearmWakes(again.rt);
  assert.equal(again.rt.timers.has(first.sc.id), false, 'no second turn is armed while its own runs on the host');
  assert.equal(again.store.state.schedules[first.sc.id]?.running, true);
  assert.notEqual(line(again, first.sc).status, 'done');
});

test('#466 a wake’s host turn on a host removed while Postbox was down stops the wake, not marked done, while its agent is placed there', async () => {
  const { r, sc } = await wakeOnHostThenRestart({ removeHost: true });
  startUp(r);
  assert.equal(r.store.state.schedules[sc.id], undefined, 'a retry there could only fail');
  assert.equal(r.rt.timers.has(sc.id), false);
  assert.equal(line(r, sc).status, 'stopped');
});

test('#466 a wake’s host turn on a host removed while Postbox was down retries the wake where its agent runs now', async () => {
  const { r, sc } = await wakeOnHostThenRestart({ removeHost: true });
  moveOff(r);
  startUp(r);
  const retry = r.store.state.schedules[sc.id];
  assert.ok(retry, 'the wake is pending again under the same id');
  assert.equal(retry.attempt, 1);
  assert.equal(retry.running, false);
  assert.ok(retry.at > Date.now() && retry.at - Date.now() <= 60_000, 'the retry uses bounded backoff');
  assert.ok(r.rt.timers.has(sc.id), 'its bounded retry is armed');
  assert.equal(line(r, sc).status, 'pending');
  clearTimeout(r.rt.timers.get(sc.id));
});

test('#466 a wake’s host turn that had started a tool, cut off from its host, retries as a recovery', async () => {
  const { r, sc } = await wakeOnHostThenRestart({ removeHost: true });
  moveOff(r);
  r.store.emit('schedule', { ...r.store.state.schedules[sc.id], startedTools: ['show_block'] });
  startUp(r);
  const retry = r.store.state.schedules[sc.id];
  assert.deepEqual(retry.recoveryTools, ['show_block']);
  assert.match(retry.recoveryNote, /cut off from its host after it started show_block/);
  assert.equal(line(r, sc).recoveryNote, retry.recoveryNote);
  clearTimeout(r.rt.timers.get(sc.id));
});

test('#466 a wake whose agent moved off its host while Postbox was down retries when the attach gives up on its turn', async () => {
  const { r, sc } = await wakeOnHostThenRestart();
  moveOff(r);
  startUp(r);
  await until(() => r.store.state.schedules[sc.id]?.attempt === 1, 'the wake to retry');
  assert.ok(r.rt.timers.has(sc.id), 'its bounded retry is armed');
  assert.equal(line(r, sc).status, 'pending');
  clearTimeout(r.rt.timers.get(sc.id));
});

for (const moved of [false, true])
  test(`#466 a wake whose host turn waits to be attached again, given up on, ${moved ? 'retries once its agent moved' : 'stops while its agent is placed there, as removing the host does'}`, async () => {
    const { r, sc } = await wakeOnHostThenRestart();
    // The host can’t be reached, so the turn waits to be attached again.
    r.hosts.ensureWelcome = async () => {
      throw unreachable();
    };
    startUp(r);
    await until(() => r.hosts.calls.need.length > 0, 'the host to be needed for the attach');
    assert.equal(r.store.state.schedules[sc.id]?.running, true, 'the wake waits with its turn');
    if (moved) moveOff(r);
    // Removing the host gives up on the turn there (stopTurnsOn), with the agent still placed on it.
    assert.equal(r.rt.remote.cancel(r.se().id), true);
    if (moved) {
      assert.equal(r.store.state.schedules[sc.id]?.attempt, 1);
      assert.ok(r.rt.timers.has(sc.id), 'its bounded retry is armed');
      assert.equal(line(r, sc).status, 'pending');
      clearTimeout(r.rt.timers.get(sc.id));
    } else {
      assert.equal(r.store.state.schedules[sc.id], undefined, 'no retry onto the host being removed');
      assert.equal(r.rt.timers.has(sc.id), false);
      assert.equal(line(r, sc).status, 'stopped');
    }
  });

test('#466 a wake’s host turn whose link gave up settles the wake once it’s attached again and ends', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const r = rig({ store: new Store(null), d });
  const sc = r.rt.schedule(r.se().id, { inMs: 60_000, note: 'Check the host.' });
  clearTimeout(r.rt.timers.get(sc.id));
  fireScheduledWake(r.rt, sc);
  await until(() => starts(d).length === 1 && d.turns.has(starts(d)[0].turn), 'the wake’s turn to start on the host');
  const hostTurn = starts(d)[0].turn;
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === hostTurn), 'the turn to be read');
  r.link.giveUp();
  await until(() => r.se().remoteTurn?.state === 'lost', 'the turn to be lost');
  await until(() => !r.rt.turns.size, 'the lost turn to end here');
  assert.equal(r.store.state.schedules[sc.id]?.running, true, 'the wake waits for the attach');
  assert.notEqual(line(r, sc).status, 'done');
  r.link.reconnect();
  await until(() => r.link.connected, 'the welcome of the new connection');
  r.hosts.emit('status', r.host.id, r.hosts.status(r.host.id));
  await until(() => r.se().remoteTurn?.state === 'running' && r.rt.turns.size === 1, 'the turn to be attached again');
  d.end(hostTurn, { code: 0, signal: null });
  await until(() => line(r, sc).status === 'done', 'the wake to settle as done');
  assert.equal(r.store.state.schedules[sc.id], undefined);
});

test('#466 giving up on the person’s host turn leaves a wake queued behind it alone', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const first = rig({ store: new Store(null), d });
  await running(first, 'Work on it.');
  first.rt.remote.close();
  d.drop();
  d.connect();
  const r = rig({ store: first.store, d });
  rearmWakes(r.rt);
  r.hosts.ensureWelcome = async () => {
    throw unreachable();
  };
  startUp(r);
  await until(() => r.hosts.calls.need.length > 0, 'the host to be needed for the attach');
  const sc = r.rt.schedule(r.se().id, { inMs: 60_000, note: 'Check later.' });
  clearTimeout(r.rt.timers.get(sc.id));
  fireScheduledWake(r.rt, sc);
  assert.equal(r.store.state.schedules[sc.id]?.running, true, 'the wake waits behind the turn to attach');
  assert.equal(r.rt.remote.cancel(r.se().id), true);
  assert.equal(r.store.state.schedules[sc.id]?.attempt, undefined, 'not retried: the turn given up wasn’t its own');
  assert.equal(r.rt.timers.has(sc.id), false);
});
