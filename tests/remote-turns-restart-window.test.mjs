// A message in the window after a restart, while a turn that went on on its host waits for the host’s welcome to be
// attached again (#1135): it waits in its thread’s queue, as for a busy agent, rather than starting a second turn on
// the host beside the one Postbox is about to attach.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageOf, restarted, rig, settled, sleep, starts, startUp, until } from './remote-turns-helpers.mjs';

/** The rig after a restart, with the first host’s welcome held until release(). @param {'running' | 'missing'} welcome */
function heldWelcome(welcome) {
  const { store, d } = restarted({ welcome });
  const r = rig({ store, d });
  let release = () => {};
  const held = new Promise((res) => {
    release = res;
  });
  const ensure = r.hosts.ensureWelcome;
  r.hosts.ensureWelcome = async (/** @type {string} */ hostId) => {
    if (hostId === r.host.id) await held;
    return ensure(hostId);
  };
  startUp(r);
  return { r, d, release };
}

const queued = (r) => (r.store.pending.thread(r.t.id)?.queue ?? []).map((q) => q.text);

test('#1135 a message while the turn waits to be attached waits in the queue, and no second turn starts on the host', async () => {
  const { r, d, release } = heldWelcome('running');
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  r.rt.sendMessage(r.t.id, { text: 'sent in the window' });
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no second turn on the host');
  assert.deepEqual(queued(r), ['sent in the window'], 'it waits in the queue, where the badge counts it');
  release();
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  await sleep(20);
  assert.equal(starts(d).length, 0, 'attached, and no second turn started beside it');
  d.end('host-turn-1');
  // The attached turn’s end hands the queue on, as any turn’s end does.
  await until(() => starts(d).length === 1, 'the queued message’s turn');
  assert.match(messageOf(starts(d)[0]), /sent in the window/);
  assert.deepEqual(queued(r), []);
});

test('#1135 a message in the window goes at once when the host says the turn is gone', async () => {
  const { r, d, release } = heldWelcome('missing');
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  r.rt.sendMessage(r.t.id, { text: 'sent in the window' });
  await sleep(20);
  assert.equal(starts(d).length, 0, 'nothing starts while the welcome is awaited');
  release();
  await until(() => starts(d).length === 1, 'the message’s turn, once the host has no such turn');
  assert.match(messageOf(starts(d)[0]), /sent in the window/);
  assert.deepEqual(queued(r), []);
  d.end(starts(d)[0].turn);
  await settled(r);
});

test('#1135 another agent’s wake while the turn waits to be attached waits in the queue too', async () => {
  const { r, d, release } = heldWelcome('running');
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  const lead = r.rt.ensureSession(r.t.id, r.rt.createPersona({ handle: 'lead', backend: 'claude-code' }).id);
  r.rt.agentWake(lead.id, 'coder', 'a wake in the window');
  await sleep(20);
  assert.deepEqual(
    (r.store.pending.thread(r.t.id)?.queue ?? []).map((q) => [q.kind, q.text]),
    [['wake', 'a wake in the window']],
  );
  release();
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no second turn beside the attached one');
  d.end('host-turn-1');
  await until(() => starts(d).length === 1, 'the wake’s turn');
  assert.match(messageOf(starts(d)[0]), /a wake in the window/);
});

test('#1135 a drain of the thread while the turn waits to be attached leaves its message queued', async () => {
  const { r, d, release } = heldWelcome('running');
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  r.rt.sendMessage(r.t.id, { text: 'sent in the window' });
  // Any drain of the thread, as another agent’s turn ending there runs, reads the agent as busy too.
  r.rt.drainQueue(r.t.id);
  await sleep(20);
  assert.equal(r.rt.turns.has(r.se().id), false, 'no turn starts for it');
  assert.deepEqual(queued(r), ['sent in the window']);
  release();
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  await sleep(20);
  assert.equal(starts(d).length, 0, 'attached, and no second turn beside it');
  d.end('host-turn-1');
  await until(() => starts(d).length === 1, 'the queued message’s turn');
  d.end(starts(d)[0].turn);
  await settled(r);
});

/**
 * Moves the agent off its silent host, as the agent panel does. `to`: this computer, or a second host.
 * @param {ReturnType<typeof heldWelcome>['r']} r @param {'here' | 'host'} to
 */
function move(r, to) {
  r.rt.updatePersona(r.se().personaId, { remote: to === 'host' ? { hostId: r.rt.addHost({ name: 'other.example.com' }).id } : null });
}

/** A turn has started where the agent was moved to: the fake daemon’s `start`, or the local spawn the rig refuses. */
const startedAfterMove = (r, d, /** @type {'here' | 'host'} */ to) => (to === 'host' ? starts(d).length === 1 : r.f.calls.some((c) => c[0] === 'spawn'));

for (const to of /** @type {const} */ (['here', 'host']))
  test(`#1135 a message after the agent moved off a silent host goes at once (${to})`, async () => {
    const { r, d, release } = heldWelcome('running');
    await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
    move(r, to);
    r.rt.sendMessage(r.t.id, { text: 'after the move' });
    assert.deepEqual(queued(r), [], 'the old host’s turn holds nothing back');
    await until(() => startedAfterMove(r, d, to), 'the turn where it runs now');
    if (to === 'host') d.end(starts(d)[0].turn);
    await settled(r);
    release();
  });

for (const to of /** @type {const} */ (['here', 'host']))
  test(`#1135 a message that waited when the agent moved off a silent host goes on the move (${to})`, async () => {
    const { r, d, release } = heldWelcome('running');
    await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
    r.rt.sendMessage(r.t.id, { text: 'before the move' });
    assert.deepEqual(queued(r), ['before the move']);
    move(r, to);
    assert.deepEqual(queued(r), [], 'nothing is left waiting for a host the agent left');
    await until(() => startedAfterMove(r, d, to), 'the turn where it runs now');
    if (to === 'host') {
      assert.match(messageOf(starts(d)[0]), /before the move/);
      d.end(starts(d)[0].turn);
    }
    await settled(r);
    release();
  });

// Whether the agent waits follows where it runs now (#1135): moved back onto the silent host before its welcome, it
// waits for the attach again, and the attach still goes.
test('#1135 a message after the agent moved off a silent host and back waits for the attach again', async () => {
  const { r, d, release } = heldWelcome('running');
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  move(r, 'here');
  r.rt.updatePersona(r.se().personaId, { remote: { hostId: r.host.id } });
  r.rt.sendMessage(r.t.id, { text: 'after moving back' });
  await sleep(20);
  assert.equal(starts(d).length, 0, 'no second turn on the host');
  assert.deepEqual(queued(r), ['after moving back'], 'it waits in the queue for the attach');
  release();
  await until(() => d.received.some((m) => m.type === 'read' && m.turn === 'host-turn-1'), 'the attach');
  d.end('host-turn-1');
  await until(() => starts(d).length === 1, 'the queued message’s turn');
  assert.match(messageOf(starts(d)[0]), /after moving back/);
  d.end(starts(d)[0].turn);
  await settled(r);
});
