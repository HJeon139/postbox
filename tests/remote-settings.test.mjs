import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { checkDestination, checkHostPath, checkHostSettings, DESTINATION_MAX, defaultHostSettings, PATH_BYTES, RANGES } from '../shared/remote-settings.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function runtime(store = new Store(null)) {
  const adapter = { name: 'mock', deliver: async () => {} };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  return new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
}

/** Asserts a runtime call throws the HTTP error with that status, and returns its message. */
function refused(fn, status = 422) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.status, status, e.message);
    return e.message;
  }
  assert.fail('expected a refusal');
}

test('a new host gets the design’s defaults, in milliseconds and bytes', () => {
  const d = defaultHostSettings();
  assert.deepEqual(d, {
    stallTimeout: 15 * MIN,
    permissionWaitMax: 24 * HOUR,
    idleTimeout: 30 * MIN,
    logRetention: 7 * 24 * HOUR,
    logMaxBytes: 256 * 1024 * 1024,
    keepAlive: { interval: 15000, count: 3 },
    dedicatedConnection: true,
    forwardAgent: false,
    denyPrompts: false,
    nodePath: null,
    claudePath: null,
    kiroPath: null,
    codexPath: null,
    detach: 'auto',
    signInCheck: null,
  });
  const rt = runtime();
  assert.deepEqual(rt.addHost({ name: 'devbox' }).settings, d);
  // Each call is a fresh copy, so one host’s change can’t leak into another’s defaults.
  defaultHostSettings().keepAlive.count = 9;
  assert.equal(defaultHostSettings().keepAlive.count, 3);
});

test('every numeric setting accepts its bounds and refuses just past them', () => {
  for (const [key, { min, max, step }] of Object.entries(RANGES)) {
    const at = (v) => (key.startsWith('keepAlive.') ? { keepAlive: { [key.slice(10)]: v } } : { [key]: v });
    const read = (s) => (key.startsWith('keepAlive.') ? s.keepAlive[key.slice(10)] : s[key]);
    for (const v of [min, max]) {
      const r = checkHostSettings(at(v));
      assert.ok(r.ok, `${key} = ${v}: ${!r.ok && r.error}`);
      assert.equal(read(r.value), v);
    }
    for (const v of [min - step, max + step, min + 0.5, String(min), null]) {
      const r = checkHostSettings(at(v));
      assert.ok(!r.ok, `${key} = ${v} should be refused`);
      assert.match(r.error, new RegExp(key.replace('.', '\\.')));
    }
  }
});

test('the stall timeout stays well above the 6 minutes between api_retry events', () => {
  assert.ok(RANGES.stallTimeout.min >= 10 * MIN);
  assert.ok(!checkHostSettings({ stallTimeout: 6 * MIN }).ok);
});

test('a permission wait can’t exceed 24 h, under Claude Code’s 27.8 h MCP ceiling', () => {
  assert.equal(RANGES.permissionWaitMax.max, 24 * HOUR);
  assert.ok(RANGES.permissionWaitMax.max < 27.8 * HOUR);
  assert.ok(!checkHostSettings({ permissionWaitMax: 25 * HOUR }).ok);
});

test('keepAlive’s interval is whole seconds, and it can be changed in part', () => {
  assert.match(/** @type {any} */ (checkHostSettings({ keepAlive: { interval: 15500 } })).error, /whole seconds/);
  const r = checkHostSettings({ keepAlive: { count: 5 } });
  assert.ok(r.ok);
  assert.deepEqual(r.value.keepAlive, { interval: 15000, count: 5 });
  assert.ok(!checkHostSettings({ keepAlive: { count: 5, every: 1 } }).ok);
  assert.ok(!checkHostSettings({ keepAlive: 15000 }).ok);
});

test('the other settings take only their own kind of value', () => {
  const good = [
    { dedicatedConnection: false },
    { forwardAgent: true },
    { denyPrompts: true },
    { detach: 'setsid' },
    { nodePath: '/opt/node/bin/node' },
    { claudePath: null },
    { signInCheck: ['klist', '-s'] },
    { signInCheck: null },
  ];
  for (const patch of good) assert.ok(checkHostSettings(patch).ok, JSON.stringify(patch));
  const bad = [
    [{ dedicatedConnection: 'yes' }, /true or false/],
    [{ forwardAgent: 1 }, /true or false/],
    [{ denyPrompts: 'none' }, /true or false/],
    [{ detach: 'systemd' }, /auto, setsid/],
    [{ kiroPath: 'kiro-cli' }, /absolute path/],
    [{ codexPath: '~/bin/codex' }, /~ isn’t expanded/],
    [{ claudePath: '/usr/bin/claude\n' }, /control characters/],
    [{ nodePath: '/opt/../node' }, /“\.\.”/],
    [{ signInCheck: 'klist -s && echo ok' }, /not a command line/],
    [{ signInCheck: [] }, /list of arguments/],
    [{ signInCheck: ['klist', 3] }, /argument 2 isn’t text/],
    [{ signInCheck: ['klist', 'a\nb'] }, /control character/],
    [{ signInCheck: ['-s'] }, /program to run/],
    [{ signInCheck: Array(33).fill('x') }, /the most is 32/],
    [{ stalltimeout: 20 * MIN }, /no host setting “stalltimeout”/],
    [['stallTimeout'], /an object/],
  ];
  for (const [patch, error] of bad) {
    const r = checkHostSettings(patch);
    assert.ok(!r.ok, JSON.stringify(patch));
    assert.match(r.error, error);
  }
});

test('a destination that ssh could read as an option or a shell could split is refused', () => {
  for (const name of ['devbox', 'user@host.example.com', 'host.example.com', 'user@[2001:db8::1]', 'my_alias-2', '10.0.0.5']) {
    const r = checkDestination(name);
    assert.ok(r.ok, `${name}: ${!r.ok && r.error}`);
  }
  // Refused, not trimmed: what’s saved is what was typed.
  assert.match(String(checkDestination('  devbox  ').error), /can’t contain spaces/);
  const bad = [
    ['-oProxyCommand=x', /can’t start with “-”/],
    ['a b', /spaces or control characters/],
    ['\n', /Name the host/],
    ['host\nProxyCommand x', /spaces or control characters/],
    ['host\u0000', /spaces or control characters/],
    ['host\u007f', /spaces or control characters/],
    ['', /Name the host/],
    ['   ', /Name the host/],
    ['host;rm', /character ssh destinations don’t use/],
    ['$(id)', /character ssh destinations don’t use/],
    ['ssh://host', /character ssh destinations don’t use/],
    ['user@', /Name a host after the @/],
    ['a'.repeat(DESTINATION_MAX + 1), /the most is 255/],
    [42, /as text/],
    [undefined, /as text/],
  ];
  for (const [name, error] of bad) {
    const r = checkDestination(name);
    assert.ok(!r.ok, JSON.stringify(name));
    assert.match(r.error, error);
    assert.match(r.error, /letters, digits/, 'the error says what’s allowed');
  }
  assert.ok(checkDestination('a'.repeat(DESTINATION_MAX)).ok);
});

test('a project’s folder on a host must be an absolute path there', () => {
  assert.ok(checkHostPath('/home/user/src/app', 'folder').ok);
  assert.ok(checkHostPath('/', 'folder').ok);
  assert.ok(checkHostPath(`/${'é'.repeat(2047)}`, 'folder').ok, '4095 bytes is the most');
  for (const [path, error] of [
    ['src/app', /absolute path/],
    ['~/src', /~ isn’t expanded/],
    ['', /absolute path/],
    ['/a/\tb', /control characters/],
    ['/a/../etc', /“\.\.”/],
    [`/${'a'.repeat(PATH_BYTES)}`, /over 4095 bytes/],
    [`/${'é'.repeat(2048)}`, /over 4095 bytes/],
    ['/srv/proj/', /can’t end with “\/”.*Write \/srv\/proj instead/],
    ['/srv/./proj', /“\.” part/],
    ['//srv', /“\/\/”/],
    ['/srv//proj', /“\/\/”/],
    [null, /as text/],
  ]) {
    const r = checkHostPath(path, 'folder');
    assert.ok(!r.ok, JSON.stringify(path));
    assert.match(r.error, error);
  }
});

test('the runtime adds, updates and removes hosts, with clear errors', async () => {
  const rt = runtime();
  assert.match(
    refused(() => rt.addHost({ name: '-oProxyCommand=x' })),
    /can’t start with “-”/,
  );
  assert.match(
    refused(() => rt.addHost({ name: 'devbox', settings: { stallTimeout: MIN } })),
    /stallTimeout must be 10 min to 24 h/,
  );
  assert.deepEqual({ ...rt.s.hosts }, {}, 'a refused host isn’t stored');

  const h = rt.addHost({ name: 'devbox', settings: { forwardAgent: true } });
  assert.match(h.id, /^ho_/);
  assert.equal(h.settings.forwardAgent, true);
  assert.equal(h.settings.stallTimeout, 15 * MIN);
  assert.match(
    refused(() => rt.addHost({ name: 'devbox' }), 409),
    /devbox is already a host/,
  );

  const u = rt.updateHost(h.id, { settings: { keepAlive: { count: 5 } } });
  assert.equal(u.settings.forwardAgent, true, 'settings not given keep their values');
  assert.deepEqual(u.settings.keepAlive, { interval: 15000, count: 5 });
  assert.equal(rt.updateHost(h.id, { name: 'user@host.example.com' }).name, 'user@host.example.com');
  assert.match(
    refused(() => rt.updateHost(h.id, { name: 'a b' })),
    /spaces/,
  );
  assert.match(
    refused(() => rt.updateHost(h.id, { settings: { detach: 'nohup' } })),
    /detach is one of/,
  );
  assert.equal(rt.s.hosts[h.id].settings.detach, 'auto', 'a refused change leaves the host as it was');
  const other = rt.addHost({ name: 'other' });
  assert.match(
    refused(() => rt.updateHost(other.id, { name: 'user@host.example.com' }), 409),
    /already a host/,
  );

  assert.deepEqual(await rt.removeHost(other.id), { ok: true, stopped: 0 });
  assert.equal(rt.s.hosts[other.id], undefined);
  await assert.rejects(rt.removeHost(other.id), (e) => e.status === 404 && /doesn’t exist/.test(e.message));
  assert.match(
    refused(() => rt.updateHost('ho_none', {}), 404),
    /doesn’t exist/,
  );
});

test('a project keeps a folder per host, and loses it when the host goes', async () => {
  const rt = runtime();
  rt.store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.addHost({ name: 'a' });
  const b = rt.addHost({ name: 'b' });
  rt.setProjectHostFolder('p1', a.id, '/home/user/app');
  rt.setProjectHostFolder('p1', b.id, '/srv/app');
  assert.deepEqual(rt.s.projects.p1.hostFolders, { [a.id]: '/home/user/app', [b.id]: '/srv/app' });
  assert.equal(rt.s.projects.p1.folder, '/tmp', 'the laptop folder is untouched');

  assert.match(
    refused(() => rt.setProjectHostFolder('p1', a.id, 'app')),
    /The project’s folder on a must be an absolute path/,
  );
  assert.match(
    refused(() => rt.setProjectHostFolder('p1', 'ho_none', '/x'), 404),
    /host doesn’t exist/,
  );
  assert.match(
    refused(() => rt.setProjectHostFolder('p_none', a.id, '/x'), 404),
    /project doesn’t exist/,
  );

  rt.setProjectHostFolder('p1', b.id, null);
  assert.deepEqual(rt.s.projects.p1.hostFolders, { [a.id]: '/home/user/app' });
  await rt.removeHost(a.id);
  assert.deepEqual(rt.s.projects.p1.hostFolders, {});
});

test('hosts and project host folders survive a store reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'postbox-remote-settings-'));
  try {
    const store = await new Store(dir).load();
    const rt = runtime(store);
    store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
    const h = rt.addHost({ name: 'devbox', settings: { idleTimeout: 2 * HOUR, signInCheck: ['klist', '-s'] } });
    rt.setProjectHostFolder('p1', h.id, '/home/user/app');
    const gone = rt.addHost({ name: 'gone' });
    await rt.removeHost(gone.id);
    await store.close();

    const again = await new Store(dir).load();
    assert.deepEqual({ ...again.state.hosts }, { [h.id]: h });
    assert.deepEqual(again.state.projects.p1.hostFolders, { [h.id]: '/home/user/app' });

    // And from a snapshot, as after a restart that wrote one.
    await again.snapshot().then(() => again.close()); // closed, so the next store can take the folder
    const fromSnapshot = await new Store(dir).load();
    assert.deepEqual({ ...fromSnapshot.state.hosts }, { [h.id]: h });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a snapshot from before hosts existed loads with none', async () => {
  const store = new Store(null);
  delete (/** @type {any} */ (store.state).hosts);
  const rt = runtime(store);
  assert.match(
    refused(() => rt.host('ho_x'), 404),
    /doesn’t exist/,
  );
  assert.equal(rt.addHost({ name: 'devbox' }).name, 'devbox');
});
