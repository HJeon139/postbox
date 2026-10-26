// What the person’s actions on a host do (#120; server/remote/hosts.mjs and host-status.mjs), with the real host
// manager in a runtime over the fake daemon: a host just added has a status (not installed, so its card offers
// Install…), and Install, Retry and Reconnect connect it now, though nothing needs it, for one welcome, then it idles.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHostManager, IDLE_GRACE_MS } from '../server/remote/hosts.mjs';
import { installCommand, tokenCommand } from '../server/remote/install.mjs';
import { createHostLink } from '../server/remote/link.mjs';
import { Store } from '../server/store.mjs';
import { defaultHostSettings } from '../shared/remote-settings.mjs';
import { createFakeDaemon, FAKE_TOKEN } from './fake-daemon.mjs';
import { fakeSsh } from './fake-ssh.mjs';
import { SIGN_IN, sleep, testClock, until, VERSION } from './remote-hosts-fixtures.mjs';
import { setup as runtime } from './remote-runtime-helpers.mjs';

/**
 * A runtime whose host manager is the real one, over a temp data folder with no tokens, and ssh to the fake daemon:
 * its install commands answer as a host would, and anything else attaches. o.spawn replaces the fake ssh for attaching.
 * @param {{ daemon?: ReturnType<typeof createFakeDaemon>, spawn?: import('../server/remote/ssh.mjs').SpawnLike }} [o]
 */
function rig({ daemon = createFakeDaemon({ autoEnd: false }), spawn } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pbh-'));
  const attach = spawn ?? fakeSsh({ daemon }).spawn;
  const scripted = fakeSsh({
    script: (child) => {
      child.stdout.write(child.answer);
      child.exit(0);
    },
  });
  /** @type {any[]} */
  const dialed = [];
  /** @type {import('../server/remote/ssh.mjs').SpawnLike} */
  const ssh = (program, args, options) => {
    const last = args.at(-1);
    if (last !== installCommand(VERSION) && last !== tokenCommand(VERSION)) {
      dialed.push(args);
      return attach(program, args, options);
    }
    const child = scripted.spawn(program, args, options);
    child.answer = last === installCommand(VERSION) ? `installed ${VERSION}\n` : `${FAKE_TOKEN}\n`;
    return child;
  };
  const store = new Store(null);
  const clock = testClock();
  const hosts = createHostManager({
    getHost: (id) => store.state.hosts?.[id] ?? null,
    hostIds: () => Object.keys(store.state.hosts ?? {}),
    dataDir,
    version: VERSION,
    spawn: ssh,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delay: () => 5,
  });
  const { rt } = runtime({ store, hosts });
  rt.watchHosts();
  const status = (/** @type {string} */ id) => store.state.hostStatus?.[id] ?? null;
  const done = () => {
    hosts.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { rt, store, hosts, daemon, clock, dialed, status, done };
}

test('#120: a host just added is not installed, at once, so its card offers Install…; one added after startup too', async () => {
  const r = rig();
  try {
    const h = r.rt.addHost({ name: 'host.example.com' });
    await sleep(0);
    assert.equal(r.status(h.id)?.state, 'not-installed');
    assert.equal(r.status(h.id)?.failure, null, 'no token here, which isn’t a failure of the link');
    // Renamed, still not installed: its status stays.
    r.rt.updateHost(h.id, { name: 'build.example.com' });
    await sleep(0);
    assert.equal(r.status(h.id)?.state, 'not-installed');
    assert.equal(r.dialed.length, 0, 'nothing dialed');
  } finally {
    r.done();
  }
});

test('#120: Install connects the host for one welcome, so its card shows what the daemon found; then it idles', async () => {
  const r = rig();
  try {
    const h = r.rt.addHost({ name: 'host.example.com' });
    assert.deepEqual(await r.rt.installHost(h.id), { ok: true, installed: true, version: VERSION });
    await until(() => r.status(h.id)?.state === 'connected', 'connected after the install');
    assert.equal(r.status(h.id).welcome.home, '/home/user');
    assert.equal(r.dialed.length, 1);
    r.clock.advance(IDLE_GRACE_MS);
    await until(() => r.status(h.id)?.state === 'disconnected', 'idle after the grace');
    assert.equal(r.status(h.id).welcome.home, '/home/user', 'what it found stays');
  } finally {
    r.done();
  }
});

test('#120: Retry connects an idle installed host nothing needs, for one welcome; then it idles', async () => {
  const r = rig();
  try {
    const h = r.rt.addHost({ name: 'host.example.com' });
    await r.rt.installHost(h.id);
    await until(() => r.status(h.id)?.state === 'connected', 'connected after the install');
    r.clock.advance(IDLE_GRACE_MS);
    await until(() => r.status(h.id)?.state === 'disconnected', 'idle');
    assert.deepEqual(r.rt.retryHost(h.id), { ok: true });
    await until(() => r.status(h.id)?.state === 'connected', 'connected on Retry');
    assert.equal(r.dialed.length, 2);
    r.clock.advance(IDLE_GRACE_MS);
    await until(() => r.status(h.id)?.state === 'disconnected', 'idle again');
  } finally {
    r.done();
  }
});

test('#120: a sign-in failure stays stopped, wake or not, until the person’s Reconnect, which dials once', async () => {
  const ssh = fakeSsh({ script: (child) => child.fail(255, SIGN_IN) });
  const r = rig({ spawn: ssh.spawn });
  try {
    const h = r.rt.addHost({ name: 'host.example.com' });
    await r.rt.installHost(h.id);
    await until(() => r.status(h.id)?.state === 'failed', 'the sign-in failure');
    assert.equal(r.status(h.id).failure.kind, 'sign-in');
    r.hosts.wake();
    await sleep(20);
    assert.equal(r.dialed.length, 1, 'a wake doesn’t redial it');
    r.rt.retryHost(h.id);
    await until(() => r.dialed.length === 2, 'Reconnect dials');
    await until(() => r.status(h.id)?.state === 'failed', 'stopped again');
    await sleep(20);
    assert.equal(r.dialed.length, 2, 'and only once');
  } finally {
    r.done();
  }
});

test('#120: Take over connects a host another Postbox has, replacing it, though nothing here needs the host', async () => {
  const daemon = createFakeDaemon({ autoEnd: false });
  const r = rig({ daemon });
  const other = createHostLink({
    host: { name: 'host.example.com', settings: defaultHostSettings() },
    version: VERSION,
    token: FAKE_TOKEN,
    spawn: fakeSsh({ daemon }).spawn,
  });
  try {
    other.on('message', () => {});
    other.need();
    await until(() => other.connected, 'the other Postbox connected');
    const h = r.rt.addHost({ name: 'host.example.com' });
    await r.rt.installHost(h.id);
    await until(() => r.status(h.id)?.failure?.kind === 'busy', 'busy');
    r.rt.retryHost(h.id, { takeover: true });
    await until(() => r.status(h.id)?.state === 'connected', 'connected, taken over');
    assert.equal(daemon.received.filter((m) => m.type === 'hello').at(-1).takeover, true);
  } finally {
    other.close();
    r.done();
  }
});
