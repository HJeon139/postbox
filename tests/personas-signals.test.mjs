// persona.updated’s listeners run in the order the design gives, where the calls ran (designs/architecture/services.md,
// “Bus” and “Risks”): whether the agent’s sessions wait for a host turn to be attached follows where it runs now, and
// only then does its queue drain. An agent moved off a silent host gets the message that waited for that host’s turn
// in the same call that moved it (#1135). If the queue drained first, the session would still count as waiting and
// the message would stay held; if the drain ran late, it would still be queued when the call returns.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restarted, rig, settled, starts, startUp, until } from './remote-turns-helpers.mjs';

/** The rig after a restart, with the first host’s welcome held until release(). */
function heldWelcome() {
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
  return { r, d, release };
}

const queued = (r) => (r.store.pending.thread(r.t.id)?.queue ?? []).map((q) => q.text);

test('moving an agent off a silent host lets go of its waiting message before the move returns, not after (#1135)', async () => {
  const { r, d, release } = heldWelcome();
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn to wait for its welcome');
  r.rt.sendMessage(r.t.id, { text: 'before the move' });
  assert.deepEqual(queued(r), ['before the move'], 'it waits for the attach');
  const other = r.rt.addHost({ name: 'other.example.com' }).id;
  r.rt.updatePersona(r.se().personaId, { remote: { hostId: other } });
  // Read in the same synchronous run as the move.
  assert.deepEqual(queued(r), [], 'the move noted the agent free, then drained its queue');
  await until(() => starts(d).length === 1, 'the turn on the host it moved to');
  d.end(starts(d)[0].turn);
  await settled(r);
  release();
});
