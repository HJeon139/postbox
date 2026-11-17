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

test('#1214 a turn left on the host an agent moved off to this computer is stopped there once the host is back, and isn’t its turn', async () => {
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
  // Its turn here is its turn now: the old one is asked to stop, and the agent doesn’t read as running on it.
  assert.equal(r.store.state.sessions[r.se().id].remoteTurn?.state, 'done', 'the old host turn is settled');
  await until(() => r.store.state.sessions[r.se().id].state === 'idle', 'the turn here to end');
  assert.equal(agentState(r.store.state.sessions[r.se().id], r.store.state).state, 'idle', 'it reads as idle, not running');
  release();
  await until(() => d.received.some((m) => m.type === 'stop' && m.turn === 'host-turn-1'), 'the old host asked to stop it');
  await settled(r);
});
