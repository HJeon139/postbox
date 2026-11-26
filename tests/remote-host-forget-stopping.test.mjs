// #1680: a deleted persona’s memory removal waits for its turn still stopping on a host. Deleting a persona stops its
// turns, but a stop on a host is a SIGINT the turn ends in its own time (designs/architecture/remote-hosts.md, “Stop
// sends SIGINT”), and it could write its memory folder again after a removal. So the host isn’t sent `forget` for it
// until the daemon confirms the turn is over, and the removal stays owed meanwhile. On the runtime and the fake daemon
// of tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchForgets } from '../server/remote/host-forget.mjs';
import { hostTurnsPort } from '../server/remote/host-turns-port.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

/** The `forget` messages Postbox sent the host. @param {any} r */
const forgets = (r) => r.link.sent.filter((/** @type {any} */ m) => m.type === 'forget').map((/** @type {any} */ m) => m.persona);

test('#1680 a persona deleted while its turn is stopping on the host is forgotten there only once that turn is over', async () => {
  const r = rig({ daemon: { stopExit: null } });
  watchForgets(r.rt.hostService);
  const turn = await running(r);
  const personaId = r.se().personaId;
  r.rt.deletePersona(personaId);
  await until(() => r.d.stops.includes(turn), 'the stop at the host');
  // Turns over before Postbox would send anything: a forget it sent at once would be here by now.
  await new Promise((done) => setImmediate(() => setImmediate(done)));
  assert.ok(r.rt.remote.stopping.has(turn), 'the turn is still stopping on the host');
  assert.deepEqual(r.store.state.hostForgets[r.host.id], [personaId], 'the removal is owed');
  assert.deepEqual(forgets(r), [], 'and not sent while the turn may still write its memory');
  // Another persona’s removal, with no turn there, isn’t held by it.
  r.rt.hostService.forgetPersona('pe_other');
  await until(() => !r.store.state.hostForgets[r.host.id].includes('pe_other'), 'pe_other’s removal settled');
  assert.deepEqual(forgets(r), ['pe_other']);
  assert.deepEqual(r.store.state.hostForgets[r.host.id], [personaId], 'the stopping persona’s still owed');
  // The turn handles its SIGINT, and the daemon says it’s over: the removal goes now, on the same connection.
  r.d.end(turn, { code: null, signal: 'SIGINT' });
  await until(() => forgets(r).length === 2, 'the forget, once the turn ended');
  assert.deepEqual(forgets(r), ['pe_other', personaId]);
  // The fake daemon answers `forgotten`, as daemon-forget.mjs does once the folder is gone.
  await until(() => r.store.state.hostForgets[r.host.id] === undefined, 'the removal settled');
  await settled(r);
});

test('#1680 only a turn stopping on that host holds a persona’s removal there', () => {
  const stopping = new Map([
    ['ta', { sessionId: 'se_a', hostId: 'ho_a', waiters: [], unconfirmed: false, personaId: 'pe_a' }],
    ['tb', { sessionId: 'se_b', hostId: 'ho_b', waiters: [], unconfirmed: false, personaId: 'pe_b' }],
  ]);
  const port = hostTurnsPort({ remote: { stopping } });
  assert.deepEqual(port.stoppingPersonas('ho_a'), ['pe_a']);
  assert.deepEqual(port.stoppingPersonas('ho_c'), []);
});
