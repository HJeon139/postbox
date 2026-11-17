// A turn left on a host when its agent moves off it (#1214). After a restart, a turn that went on there waits to be
// attached until the host’s welcome; the person moves the agent to another host, and a turn starts there without the
// queue (Send now, a scheduled wake, #1135’s gap). That turn no longer hides the old one: the old host is asked to
// stop it, at once or when it’s back, and the attach no longer waits for it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentState } from '../shared/agent-state.mjs';
import * as arrange from './arrange.mjs';
import { restarted, rig, settled, starts, startUp, until } from './remote-turns-helpers.mjs';

test('#1214 a turn left on the host an agent moved off is stopped there once the host is back, and isn’t attached', async () => {
  const { store, d } = restarted({ welcome: 'running' });
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
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  const other = r.rt.addHost({ name: 'other.example.com' });
  const persona = Object.values(r.store.state.personas)[0];
  r.store.emit('persona', { ...persona, remote: { hostId: other.id } });
  r.rt.turnService.run(r.se().id, { kind: 'user', text: 'Send now, after the move' }, { threadId: r.t.id });
  await until(() => starts(d).length === 1, 'the turn on the other host');
  assert.equal(r.rt.remote.restoring.has('host-turn-1'), false, 'the attach no longer waits for it');
  release();
  await until(() => d.received.some((m) => m.type === 'stop' && m.turn === 'host-turn-1'), 'the old host asked to stop it');
  d.end(starts(d)[0].turn);
  await settled(r);
});

test('#1214 #1442 a turn left on the host an agent moved off to this computer is stopped there once the host is back, and reads as stopping until the host confirms', async () => {
  const { store, d } = restarted({ welcome: 'running' });
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
  // The host doesn’t confirm a stop until the test lets it, so what the agent reads as meanwhile can be checked.
  /** @type {any[]} */
  const heldStops = [];
  let holdStops = true;
  const send = r.link.send;
  r.link.send = (/** @type {any} */ m) => (holdStops && m.type === 'stop' ? heldStops.push(m) > 0 : send(m));
  startUp(r);
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  // On this computer, a backend whose turn says one word and ends.
  arrange.withAdapter(r.rt, {
    name: 'mock',
    async deliver(_se, _m, /** @type {any} */ ctx) {
      ctx.text('Here now.');
    },
  });
  const persona = Object.values(r.store.state.personas)[0];
  r.store.emit('persona', { ...persona, backend: 'mock', remote: null });
  r.rt.turnService.run(r.se().id, { kind: 'user', text: 'Send now, after the move' }, { threadId: r.t.id });
  await until(() => r.rt.remote.restoring.has('host-turn-1') === false, 'the attach no longer waits for it');
  const se = () => r.store.state.sessions[r.se().id];
  await until(() => se().state === 'idle', 'the turn here to end');
  // The old turn may still run on the host until it confirms the stop: its row says so, and the agent reads as
  // stopping there, not as running (#1442).
  assert.equal(se().remoteTurn?.state, 'stopping', 'the old host turn shows as stopping');
  assert.equal(agentState(se(), r.store.state).state, 'stopping', 'it reads as stopping, not running');
  release();
  holdStops = false;
  for (const m of heldStops.splice(0)) send(m);
  await until(() => d.received.some((m) => m.type === 'stop' && m.turn === 'host-turn-1'), 'the old host asked to stop it');
  await until(() => se().remoteTurn?.state === 'done', 'the host to confirm the stop');
  assert.equal(agentState(se(), r.store.state).state, 'idle', 'once the host confirms, it reads as idle');
  await settled(r);
});
