// #965’s P3: a host turn Postbox gives up attaching after a restart because its agent’s backend isn’t registered here
// is marked resume.noBackend, so the Interrupted hint (app/js/remote.mjs, resumeHint) says it waits for that backend,
// not that it resumes once the host is back: autoResume won’t while the backend is missing. Once the backend is
// registered and Postbox restarted, restore clears the mark, and the turn resumes on its own as before (#909).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { restarted, rig, settled, sleep, startUp, until } from './remote-turns-helpers.mjs';

/**
 * A Postbox restarted during @coder’s turn on a host that has no record of it, with its backend registered or not;
 * `moved` puts the agent on this computer since, so a turn whose backend is here still waits, for the person.
 * @param {{ backend: boolean, moved?: boolean }} o
 */
async function gaveUp({ backend, moved = false }) {
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  if (moved) r.store.emit('persona', { ...r.rt.persona(r.se().personaId), remote: null });
  if (!backend) r.rt.adapters = new AdapterRegistry();
  startUp(r);
  await until(() => r.se().remoteTurn?.state === 'interrupted', 'Interrupted');
  await settled(r);
  await sleep(20);
  return { r, d, store };
}

test('#965 a turn given up because its backend isn’t registered is marked noBackend; one given up otherwise isn’t', async () => {
  const missing = await gaveUp({ backend: false });
  assert.equal(missing.r.se().remoteTurn.resume?.noBackend, true);
  const moved = await gaveUp({ backend: true, moved: true });
  assert.equal(moved.r.se().remoteTurn.resume?.noBackend, undefined, 'given up because the agent moved, with its backend here');
});

test('#965 a restart with the backend registered again clears the mark; one with it still missing keeps it', async () => {
  for (const backend of [true, false]) {
    const first = await gaveUp({ backend: false });
    first.r.rt.remote.close();
    first.d.drop();
    first.d.connect();
    const again = rig({ store: first.store, d: first.d });
    if (!backend) again.rt.adapters = new AdapterRegistry();
    startUp(again);
    await sleep(20);
    assert.equal(Boolean(again.se().remoteTurn.resume?.noBackend), !backend, backend ? 'registered again' : 'still missing');
  }
});
