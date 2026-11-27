// #1796: a deleted persona’s memory removal on a host stays held for its turn still stopping there across a Postbox
// restart. #1680 holds the removal until the host confirms the stop, and that stop was kept only on the persona’s
// session, which deleting the persona deletes, so a restart lost it and the removal went at the next connection. A
// session removed with stops still unconfirmed now leaves each in its host’s record (`hostStops`), which a restart asks
// again. On the runtime and the fake daemon of tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchForgets } from '../server/remote/host-forget.mjs';
import { rig, running, until } from './remote-turns-helpers.mjs';

/** The `forget` messages Postbox sent the host. @param {any} r */
const forgets = (r) => r.link.sent.filter((/** @type {any} */ m) => m.type === 'forget').map((/** @type {any} */ m) => m.persona);

/**
 * A persona deleted while its turn is stopping on the host, whose daemon runs a stopped turn on until end(); then
 * Postbox restarts on the same store, and the host connects again with that turn still running there.
 */
async function deletedThenRestarted() {
  const first = rig({ daemon: { stopExit: null } });
  const turn = await running(first);
  const personaId = first.se().personaId;
  first.rt.deletePersona(personaId);
  await until(() => first.d.stops.includes(turn), 'the stop at the host');
  // Postbox stops; the turn runs on there, and its old connection goes with the old Postbox.
  first.rt.remote.close();
  first.d.drop();
  first.d.connect();
  const r = rig({ store: first.store, d: first.d });
  watchForgets(r.rt.hostService);
  r.rt.restoreRemoteTurns();
  await until(() => r.link.connected, 'the welcome of the new connection');
  // As hosts.mjs reports the connection to whoever listens.
  r.hosts.emit('status', r.host.id, r.hosts.status(r.host.id));
  return { r, turn, personaId };
}

test('#1796 a persona deleted while its turn is stopping on a host keeps its removal there held across a restart', async () => {
  const { r, turn, personaId } = await deletedThenRestarted();
  // A forget that didn’t wait goes as the connection is reported, so it would be here by now.
  await new Promise((done) => setImmediate(() => setImmediate(done)));
  assert.deepEqual(forgets(r), [], 'no forget while the turn may still write its memory');
  assert.deepEqual(r.store.state.hostForgets[r.host.id], [personaId], 'the removal is still owed');
  // The stop is asked again at the new connection, and the removal waits for its answer.
  await until(() => r.d.stops.filter((t) => t === turn).length === 2, 'the stop asked again after the restart');
  assert.deepEqual(forgets(r), []);
  // The turn handles its SIGINT and ends. The host connects again, and its welcome lists the turn ended: the stop is
  // confirmed, and the removal goes, and settles. (The real daemon also sends `ended` on the stop’s connection, which
  // the fake does only for a stop it ends at once.)
  r.d.end(turn, { code: null, signal: 'SIGINT' });
  r.link.reconnect();
  await until(() => forgets(r).length === 1, 'the forget, once the turn ended');
  assert.deepEqual(forgets(r), [personaId]);
  await until(() => r.store.state.hostForgets[r.host.id] === undefined, 'the removal settled');
  assert.equal(r.store.state.hostStops?.[r.host.id], undefined, 'and the host’s record let the stop go');
});

test('#1796 a removed session’s unconfirmed stop is kept in its host’s record until the host confirms it', async () => {
  const r = rig({ daemon: { stopExit: null } });
  const turn = await running(r);
  const personaId = r.se().personaId;
  r.rt.deletePersona(personaId);
  const kept = r.store.state.hostStops?.[r.host.id] ?? [];
  assert.deepEqual(
    kept.map((/** @type {any} */ x) => [x.turn, x.personaId, x.unconfirmed]),
    [[turn, personaId, false]],
    'kept by its host, with whose turn it is',
  );
  assert.equal(typeof kept[0].at, 'number');
  r.d.end(turn, { code: null, signal: 'SIGINT' });
  await until(() => !r.rt.remote.stopping.has(turn), 'the stop confirmed');
  assert.equal(r.store.state.hostStops?.[r.host.id], undefined, 'dropped once the host confirms the turn is over');
});

test('#1796 a deleted conversation’s unconfirmed stop is kept in its host’s record too, by whose turn it is', async () => {
  const r = rig({ daemon: { stopExit: null } });
  const turn = await running(r);
  const personaId = r.se().personaId;
  r.rt.deleteThread(r.t.id);
  assert.ok(r.store.state.personas[personaId], 'the persona stays');
  assert.deepEqual(
    (r.store.state.hostStops?.[r.host.id] ?? []).map((/** @type {any} */ x) => [x.turn, x.personaId]),
    [[turn, personaId]],
  );
});

test('#1796 a host’s kept stops go with the host', () => {
  const r = rig();
  r.store.emit('host.forget', { id: r.host.id, stop: { turn: 'host-turn-1', personaId: 'pe_gone', unconfirmed: false, at: 1 } });
  assert.equal(r.store.state.hostStops[r.host.id].length, 1);
  r.store.emit('host', { id: r.host.id, removed: true });
  assert.equal(r.store.state.hostStops?.[r.host.id], undefined);
  // A host removed meanwhile, as behind a held commit, keeps nothing.
  r.store.emit('host.forget', { id: r.host.id, stop: { turn: 'host-turn-2', personaId: 'pe_gone', unconfirmed: false, at: 2 } });
  assert.equal(r.store.state.hostStops?.[r.host.id], undefined);
});

test('#1796 a kept stop that names no turn, as a damaged log line could, isn’t kept', () => {
  const r = rig();
  r.store.emit('host.forget', { id: r.host.id, stop: { personaId: 'pe_gone', unconfirmed: false, at: 1 } });
  assert.equal(r.store.state.hostStops?.[r.host.id], undefined, 'nothing a confirmation could ever drop');
  r.store.emit('host.forget', { id: r.host.id, stop: { turn: 'host-turn-1', personaId: 'pe_gone', unconfirmed: false, at: 1 } });
  r.store.emit('host.forget', { id: r.host.id, stop: { turn: 'host-turn-1', personaId: 'pe_gone', unconfirmed: true, at: 2 } });
  assert.deepEqual(
    r.store.state.hostStops[r.host.id].map((/** @type {any} */ x) => [x.turn, x.unconfirmed]),
    [['host-turn-1', true]],
    'one record per turn, the later one',
  );
});

test('#1796 a stop asked for its session and kept by its host too lets the record go when the host confirms it', async () => {
  const first = rig({ daemon: { stopExit: null } });
  const turn = await running(first);
  first.rt.stop(first.se().id);
  await until(() => first.d.stops.includes(turn), 'the stop at the host');
  // Both at once, as when the session’s removal was refused after its host had recorded the stop.
  first.store.emit('host.forget', { id: first.host.id, stop: { turn, personaId: first.se().personaId, unconfirmed: false, at: 1 } });
  first.rt.remote.close();
  first.d.drop();
  first.d.connect();
  const r = rig({ store: first.store, d: first.d });
  r.rt.restoreRemoteTurns();
  await until(() => r.link.connected, 'the welcome of the new connection');
  r.d.end(turn, { code: null, signal: 'SIGINT' });
  r.link.reconnect();
  await until(() => !r.rt.remote.stopping.has(turn), 'the stop confirmed');
  await until(() => r.store.state.hostStops?.[r.host.id] === undefined, 'the host’s record let the stop go');
});

test('#1796 a kept stop whose start went unconfirmed is asked again after a restart, not taken as over from a welcome that doesn’t list it', async () => {
  const first = rig();
  first.store.emit('host.forget', { id: first.host.id, add: ['pe_gone'] });
  first.store.emit('host.forget', { id: first.host.id, stop: { turn: 'host-turn-x', personaId: 'pe_gone', unconfirmed: true, at: 1 } });
  first.rt.remote.close();
  const r = rig({ store: first.store, d: first.d });
  watchForgets(r.rt.hostService);
  r.rt.restoreRemoteTurns();
  await until(() => r.link.connected, 'the welcome of the new connection');
  r.hosts.emit('status', r.host.id, r.hosts.status(r.host.id));
  // The daemon never had the turn: it answers the stop with no-turn, which confirms it.
  await until(() => !r.rt.remote.stopping.has('host-turn-x'), 'the stop confirmed');
  assert.ok(
    r.d.received.some((/** @type {any} */ m) => m.type === 'stop' && m.turn === 'host-turn-x'),
    'asked, as its start may still reach the daemon',
  );
  await until(() => r.store.state.hostStops?.[r.host.id] === undefined, 'the host’s record let the stop go');
  await until(() => forgets(r).includes('pe_gone'), 'and the removal went');
});
