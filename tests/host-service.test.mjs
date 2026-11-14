// Hosts’ interface (designs/architecture/services.md, “Hosts”): adding, changing and removing the person’s remote hosts,
// a project’s folder on one, their status as the page sees it, installing there and connecting again. Built on an
// in-memory store and the real Running, with a fake of Personas, a fake host manager and a `hostTurns` port that
// records what it was asked; it never builds Runtime, and reaches no host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hosts } from '../server/remote/host-service.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';

/** A host manager that answers as told: `state` is each host’s link, and `removal` how removing Postbox there goes. */
function manager({ state = 'connected', removal = null } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {((id: string) => void)[]} */
  const listeners = [];
  return {
    calls,
    emitStatus: (/** @type {string} */ id) => {
      for (const fn of listeners) fn(id);
    },
    status: (/** @type {string} */ id) => (state ? { state, lastHeard: 5, keepUpdated: false, welcome: null, failure: null, id } : null),
    refresh: async (/** @type {string} */ id) => calls.push(`refresh ${id}`),
    removeFromHost: async (/** @type {string} */ id) => {
      calls.push(`removeFromHost ${id}`);
      if (removal) throw removal;
    },
    forget: async (/** @type {string} */ id) => calls.push(`forget ${id}`),
    on: (/** @type {string} */ _event, /** @type {(id: string) => void} */ fn) => listeners.push(fn),
    setKeepUpdated: async (/** @type {string} */ id, /** @type {boolean} */ on) => calls.push(`keepUpdated ${id} ${on}`),
    describeInstall: async (/** @type {string} */ id) => ({ text: `Install on ${id}` }),
    install: async () => {
      throw Object.assign(new Error('Postbox has no token for that host.'), { name: 'SshFailure', kind: 'not-installed', next: 'Install it.' });
    },
    link: (/** @type {string} */ id) => calls.push(`link ${id}`),
    connect: async (/** @type {string} */ id, /** @type {any} */ opts) => calls.push(`connect ${id} ${opts.takeover}`),
  };
}

/** Hosts over a store with one project and alpha, placed on a host once one is added; `turns` is the hostTurns port’s answers. */
function rig({ hosts = manager(), busy = false, left = [], noToken = false, stoppable = [] } = {}) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  store.emit('session', { id: 'se_1', personaId: 'pe_a', threadId: 'th_c', handle: 'alpha', backend: 'mock' });
  store.emit('session', { id: 'se_2', personaId: 'pe_b', threadId: 'th_c', handle: 'beta', backend: 'mock' });
  const running = new Running();
  /** @type {Record<string, any>} */
  const placed = {};
  const personas = { get: (/** @type {string} */ id) => ({ id, remote: placed[id] ? { hostId: placed[id] } : null }) };
  /** @type {string[]} */
  const asked = [];
  /** Records what the port was asked, and answers. @param {string} what @param {any} answer */
  const ask = (what, answer) => {
    asked.push(what);
    return answer;
  };
  const hostTurns = {
    busyOn: (/** @type {string} */ id) => ask(`busyOn ${id}`, busy),
    sessionsOn: (/** @type {string} */ id) => ask(`sessionsOn ${id}`, ['se_2']),
    stopOn: (/** @type {string} */ sessionId) => ask(`stopOn ${sessionId}`, stoppable.includes(sessionId)),
    cancel: (/** @type {string} */ sessionId) => ask(`cancel ${sessionId}`, true),
    confirmStops: async (/** @type {string} */ id) => ask(`confirmStops ${id}`, { left, noToken }),
    stoppingSession: (/** @type {string} */ turnId) => (turnId === 'tu_1' ? 'se_1' : null),
  };
  const service = new Hosts({ store, personas, running, hostTurns, hosts });
  return { store, running, placed, asked, service, hosts };
}

const refused = (status, pattern) => (/** @type {any} */ e) => e.status === status && pattern.test(e.message);

// ── Adding, changing and removing ────────────────────────────────────────────────────

test('add stores a host with its checked settings, and refuses one already there with a 409', () => {
  const { store, service } = rig();
  const h = service.add({ name: 'dev@box', settings: { denyPrompts: true } });
  assert.deepEqual([store.state.hosts[h.id].name, store.state.hosts[h.id].settings.denyPrompts], ['dev@box', true]);
  assert.throws(() => service.add({ name: 'dev@box' }), refused(409, /^dev@box is already a host\.$/));
  assert.throws(
    () => service.add({ name: '-oProxyCommand=x' }),
    (e) => e.status === 422,
  );
});

test('update refuses a new destination while turns run there, asking the hostTurns port, and keeps the host as it was', () => {
  const { store, service, asked } = rig({ busy: true });
  const h = service.add({ name: 'dev@box' });
  assert.throws(
    () => service.update(h.id, { name: 'dev@other' }),
    refused(
      409,
      /^dev@box can’t be renamed while agents’ turns run there or wait to go on there: they’d carry on on dev@box while new ones went to dev@other\./,
    ),
  );
  assert.deepEqual(asked, [`busyOn ${h.id}`]);
  assert.equal(store.state.hosts[h.id].name, 'dev@box');
});

test('update sends a connected host a change to a setting its daemon enforces, and drops the link of one renamed', async () => {
  const { service, hosts } = rig();
  const h = service.add({ name: 'dev@box' });
  service.update(h.id, { settings: { denyPrompts: true } });
  service.update(h.id, { settings: { idleTimeout: 60 * 60 * 1000 } });
  service.update(h.id, { name: 'dev@other' });
  await Promise.resolve();
  assert.deepEqual(hosts.calls, [`refresh ${h.id}`, `refresh ${h.id}`]);
});

test('remove stops the turns on the host through hostTurns, waits for them, leaves the host, and drops its folders', async () => {
  const { store, running, placed, asked, service, hosts } = rig({ stoppable: ['se_1'] });
  const h = service.add({ name: 'dev@box' });
  placed.pe_a = h.id;
  service.setProjectFolder('p1', h.id, '/srv/p');
  // alpha’s turn there stops and is still exiting when the stop returns: the removal waits for it to end.
  const turn = { sessionId: 'se_1', exited: Promise.resolve() };
  running.begin(turn);
  running.exit('se_1', { turn, held: [], silent: true });
  assert.deepEqual(await service.remove(h.id, { waitMs: 50 }), { ok: true, stopped: 2 });
  assert.deepEqual(asked, [`sessionsOn ${h.id}`, 'stopOn se_2', 'cancel se_2', 'stopOn se_1', `confirmStops ${h.id}`]);
  assert.deepEqual(hosts.calls, [`removeFromHost ${h.id}`, `forget ${h.id}`]);
  assert.deepEqual([store.state.hosts[h.id], store.state.projects.p1.hostFolders], [undefined, {}]);
});

test('remove is refused while the host hasn’t confirmed its turns stopped, naming them when its token is gone', async () => {
  const gone = rig({ left: ['tu_1', 'tu_2'], noToken: true });
  const a = gone.service.add({ name: 'dev@box' });
  await assert.rejects(
    gone.service.remove(a.id, { waitMs: 0 }),
    refused(
      409,
      /^dev@box’s token isn’t on this computer any more, so Postbox can’t reach it to stop 2 running turns: @alpha, an agent\. Install Postbox on dev@box again to stop them, then remove it\.$/,
    ),
  );
  assert.ok(gone.store.state.hosts[a.id], 'the host is kept');
  const away = rig({ left: ['tu_1'], hosts: manager({ state: 'disconnected' }) });
  const b = away.service.add({ name: 'dev@box' });
  await assert.rejects(away.service.remove(b.id, { waitMs: 0 }), refused(409, /^dev@box can’t be reached, so its running turns can’t be stopped;/));
});

test('remove keeps the host when Postbox can’t remove itself there, with the reason and the next step', async () => {
  const failure = Object.assign(new Error('The host said no.'), { kind: 'failed', next: 'Try again.' });
  const { store, service } = rig({ hosts: manager({ removal: failure }) });
  const h = service.add({ name: 'dev@box' });
  await assert.rejects(
    service.remove(h.id, { waitMs: 0 }),
    (/** @type {any} */ e) => e.status === 409 && e.code === 'failed' && e.next === 'Try again.' && /Postbox keeps dev@box and its token here/.test(e.message),
  );
  assert.ok(store.state.hosts[h.id]);
});

test('setProjectFolder sets an absolute folder on a host, null clears it, and a missing project or host is a 404', () => {
  const { store, service } = rig();
  const h = service.add({ name: 'dev@box' });
  service.setProjectFolder('p1', h.id, '/srv/p');
  assert.deepEqual(store.state.projects.p1.hostFolders, { [h.id]: '/srv/p' });
  service.setProjectFolder('p1', h.id, null);
  assert.deepEqual(store.state.projects.p1.hostFolders, {});
  assert.throws(
    () => service.setProjectFolder('p1', h.id, 'relative'),
    (e) => e.status === 422,
  );
  assert.throws(
    () => service.setProjectFolder('p_none', h.id, '/x'),
    (e) => e.status === 404,
  );
  assert.throws(() => service.get('ho_none'), refused(404, /^That host doesn’t exist\. It may have been removed\.$/));
});

// ── Status, installs and connecting ──────────────────────────────────────────────────

test('watch publishes each host’s status as the manager reports it, at its status events and after a host’s change', async () => {
  const { store, service, hosts } = rig();
  const h = service.add({ name: 'dev@box' });
  service.watch();
  assert.equal(store.state.hostStatus[h.id].state, 'connected');
  assert.deepEqual(service.status(h.id), store.state.hostStatus[h.id]);
  const added = service.add({ name: 'dev@two' });
  assert.equal(store.state.hostStatus?.[added.id], undefined, 'the page hears of the host before its status');
  await Promise.resolve();
  assert.equal(store.state.hostStatus[added.id].state, 'connected');
  hosts.emitStatus(h.id);
  assert.equal(store.state.hostStatus[h.id].lastHeard, 5);
});

test('install answers a host with no token as a 409 with its kind and next step, and with no manager a 503', async () => {
  const { service } = rig();
  const h = service.add({ name: 'dev@box' });
  await assert.rejects(service.install(h.id), (/** @type {any} */ e) => e.status === 409 && e.code === 'not-installed' && e.next === 'Install it.');
  assert.deepEqual(await service.describeInstall(h.id), { text: `Install on ${h.id}` });
  const none = rig({ hosts: null });
  const n = none.service.add({ name: 'dev@box' });
  assert.throws(() => none.service.retry(n.id), refused(503, /wasn’t started with remote hosts/));
  assert.equal(none.service.status(n.id), null);
});

test('retry links and connects the host, taking over only when asked, and setKeepUpdated takes exactly { on }', async () => {
  const { service, hosts } = rig();
  const h = service.add({ name: 'dev@box' });
  assert.deepEqual(service.retry(h.id, { takeover: true }), { ok: true });
  assert.throws(
    () => service.retry(h.id, { takeover: 'yes' }),
    (e) => e.status === 422,
  );
  assert.deepEqual(await service.setKeepUpdated(h.id, { on: true }), { ok: true, keepUpdated: true });
  await assert.rejects(service.setKeepUpdated(h.id, { on: true, extra: 1 }), (e) => e.status === 422);
  assert.deepEqual(hosts.calls, [`link ${h.id}`, `connect ${h.id} true`, `keepUpdated ${h.id} true`]);
});
