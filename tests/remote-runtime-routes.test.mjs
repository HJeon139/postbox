// Remote hosts in the API (#120; tests/remote-runtime.test.mjs says how): the host routes behind the page’s token (#74),
// the server’s host manager and wake, and the backends it lists.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tokenFile } from '../server/remote/install.mjs';
import { SshFailure, failure as sshFailure } from '../server/remote/ssh.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { FakeHosts, fakeClock, refused } from './remote-runtime-helpers.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

// ── The routes ──────────────────────────────────────────────────────────────────────

const PORT = 4443;
let app;
let dir;
const fake = new FakeHosts();
const wakeClock = fakeClock();
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
const pageCookie = async () => (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-hosts-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, hosts: fake, wake: wakeClock });
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  // Stopping the server stops noticing wakes and closes the hosts’ links.
  assert.equal(wakeClock.cleared, true);
  assert.deepEqual(fake.calls.at(-1), ['close']);
});

test('#120: the page adds a host, sets a project’s folder on it, installs, retries, reads its status and removes it', async () => {
  const cookie = await pageCookie();
  const added = await call({ method: 'POST', path: '/api/hosts', body: { name: 'host.example.com', settings: { forwardAgent: false } }, cookie });
  assert.equal(added.status, 201, added.text);
  const id = added.json.id;
  const patched = await call({ method: 'PATCH', path: `/api/hosts/${id}`, body: { settings: { denyPrompts: true } }, cookie });
  assert.equal(patched.json.settings.denyPrompts, true);
  const bad = await call({ method: 'POST', path: '/api/hosts', body: { name: '-oProxyCommand=x' }, cookie });
  assert.equal(bad.status, 422);

  const project = Object.values(app.store.state.projects)[0];
  const folder = await call({ method: 'PUT', path: `/api/projects/${project.id}/hosts/${id}/folder`, body: { folder: '/home/user/app' }, cookie });
  assert.equal(folder.status, 200, folder.text);
  assert.equal(app.store.state.projects[project.id].hostFolders[id], '/home/user/app');
  const relative = await call({ method: 'PUT', path: `/api/projects/${project.id}/hosts/${id}/folder`, body: { folder: 'app' }, cookie });
  assert.equal(relative.status, 422);
  await call({ method: 'PUT', path: `/api/projects/${project.id}/hosts/${id}/folder`, body: { folder: null }, cookie });
  assert.deepEqual(app.store.state.projects[project.id].hostFolders, {});

  // The confirm’s text comes first, by GET, and installing is a write the page makes after it.
  const described = await call({ path: `/api/hosts/${id}/install` });
  assert.match(described.json.text, /^Install Postbox’s host program on host\.example\.com\?/);
  assert.deepEqual(fake.calls, [], 'reading what an install does installs nothing');
  const installed = await call({ method: 'POST', path: `/api/hosts/${id}/install`, body: {}, cookie });
  // What it did, and never the daemon’s token, which stays out of what the page reads.
  assert.deepEqual(installed.json, { ok: true, installed: true, version: '0.18.0' });
  await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: { takeover: true }, cookie });
  await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: {}, cookie });
  const odd = await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: { takeover: 'yes' }, cookie });
  assert.equal(odd.status, 422);
  assert.deepEqual(fake.calls, [
    ['install', id],
    ['retry', id, { takeover: true }],
    ['retry', id, { takeover: false }],
  ]);

  fake.statuses.set(id, { state: 'connected', failure: null, welcome: null, lastHeard: 5 });
  fake.emit('status', id, fake.statuses.get(id));
  assert.deepEqual((await call({ path: `/api/hosts/${id}/status` })).json.status, { state: 'connected', failure: null, welcome: null, lastHeard: 5 });
  const state = await call({ path: '/api/state' });
  assert.equal(state.json.state.hosts[id].name, 'host.example.com');
  assert.equal(state.json.state.hostStatus[id].state, 'connected');

  const removed = await call({ method: 'DELETE', path: `/api/hosts/${id}`, cookie });
  assert.deepEqual(removed.json, { ok: true, stopped: 0 });
  assert.deepEqual(fake.calls.at(-1), ['forget', id]);
  assert.equal((await call({ path: `/api/hosts/${id}/status` })).status, 404);
});

test('#120 L6: a failed install reaches the page with its message and next step, and a host with no token here, or renamed while busy, is a 409', async () => {
  const cookie = await pageCookie();
  const id = (await call({ method: 'POST', path: '/api/hosts', body: { name: 'fails.example.com' }, cookie })).json.id;
  fake.installError = new SshFailure('failed', 'Postbox couldn’t install its host program on fails.example.com: the disk is full.', 'Install again.');
  const failed = await call({ method: 'POST', path: `/api/hosts/${id}/install`, body: {}, cookie });
  fake.installError = null;
  assert.equal(failed.status, 502, failed.text);
  assert.deepEqual(failed.json, {
    error: 'Postbox couldn’t install its host program on fails.example.com: the disk is full.',
    code: 'failed',
    next: 'Install again.',
  });
  // Retrying a host this computer has no token for says to install it, rather than a 500.
  const link = fake.link;
  fake.link = () => {
    throw Object.assign(sshFailure('not-installed', 'fails.example.com'), { code: 'not-installed' });
  };
  const retried = await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: {}, cookie });
  fake.link = link;
  assert.equal(retried.status, 409, retried.text);
  assert.equal(retried.json.code, 'not-installed');
  assert.match(retried.json.next, /^Install Postbox on fails\.example\.com from the host’s settings/);
  // A host renamed while a turn still uses its old name (the manager’s host-renamed-busy) is a 409 saying so, too.
  const busy = 'This host was renamed renamed.example.com, but Postbox is still using fails.example.com for it. Try again once its turns there end.';
  fake.link = () => {
    throw Object.assign(new Error(busy), { code: 'host-renamed-busy' });
  };
  const renamed = await call({ method: 'POST', path: `/api/hosts/${id}/retry`, body: {}, cookie });
  fake.installError = Object.assign(new Error(busy), { code: 'host-renamed-busy' });
  const reinstalled = await call({ method: 'POST', path: `/api/hosts/${id}/install`, body: {}, cookie });
  fake.installError = null;
  fake.link = link;
  for (const r of [renamed, reinstalled]) {
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, busy);
    assert.equal(r.json.code, 'host-renamed-busy');
  }
  await call({ method: 'DELETE', path: `/api/hosts/${id}`, cookie });
});

test('#120: the host routes refuse a write without the page’s token, and change nothing', async () => {
  const cookie = await pageCookie();
  const id = (await call({ method: 'POST', path: '/api/hosts', body: { name: 'token.example.com' }, cookie })).json.id;
  const project = Object.values(app.store.state.projects)[0];
  const before = fake.calls.length;
  for (const [method, path, body] of [
    ['POST', '/api/hosts', { name: 'other.example.com' }],
    ['PATCH', `/api/hosts/${id}`, { name: 'renamed.example.com' }],
    ['DELETE', `/api/hosts/${id}`, undefined],
    ['POST', `/api/hosts/${id}/install`, {}],
    ['POST', `/api/hosts/${id}/retry`, {}],
    ['PUT', `/api/projects/${project.id}/hosts/${id}/folder`, { folder: '/srv' }],
  ]) {
    const r = await call({ method, path, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.code, 'token');
  }
  assert.equal(fake.calls.length, before, 'no install, retry or forget');
  assert.deepEqual(
    Object.values(app.store.state.hosts).map((h) => h.name),
    ['token.example.com'],
  );
  assert.equal(app.store.state.projects[project.id].hostFolders?.[id], undefined);
});

test('#120 D2: the server wakes its hosts when this computer wakes', async () => {
  wakeClock.pass(30_000);
  assert.equal(fake.calls.filter((c) => c[0] === 'wake').length, 0);
  wakeClock.pass(20 * 60_000);
  assert.equal(fake.calls.filter((c) => c[0] === 'wake').length, 1);
});

test('#120: left out, the server makes the real host manager, keeping tokens in its data folder, and closes it at close', async () => {
  const own = await mkdtemp(join(tmpdir(), 'pb-hosts-own-'));
  const server = await start({ port: PORT + 1, dataDir: own, fresh: true, demo: true, quiet: true, claudeHome: own, listen: false });
  try {
    const hosts = server.rt.hosts;
    assert.equal(typeof hosts?.refresh, 'function', 'server/remote/hosts.mjs’s manager');
    const h = server.rt.addHost({ name: 'host.example.com' });
    assert.equal(server.rt.hostStatus(h.id).state, 'not-installed', 'no token in its data folder yet');
    // A host whose token install.mjs wrote there is installed.
    const h2 = server.rt.addHost({ name: 'other.example.com' });
    await mkdir(join(own, 'remote-tokens'), { recursive: true, mode: 0o700 });
    await writeFile(tokenFile(own, h2.id), 'fake-token-0123456789abcdefghijklmnop\n', { mode: 0o600 });
    assert.equal(server.rt.hostStatus(h2.id).state, 'disconnected', 'installed: its token is in the data folder');
    assert.equal(hosts.link(h2.id), hosts.link(h2.id));
    await server.close();
    assert.throws(() => hosts.link(h2.id), /closed its host connections/);
  } finally {
    await rm(own, { recursive: true, force: true });
  }
});

test('#120: Claude Code, Kiro CLI and Codex are listed without their CLI here, marked not local, and this computer’s list leaves them out', async () => {
  const own = await mkdtemp(join(tmpdir(), 'pb-hosts-probes-'));
  const none = async () => null;
  const nothing = async () => [];
  // Only Claude Code is on this computer; nothing is probed for real.
  const probes = {
    claude: async () => '2.1.296',
    sdk: none,
    kiro: none,
    kiroModels: nothing,
    agy: none,
    agyModels: nothing,
    codex: none,
    codexModels: nothing,
  };
  const server = await start({ port: PORT + 2, dataDir: own, fresh: true, quiet: true, claudeHome: own, listen: false, hosts: new FakeHosts(), probes });
  try {
    const state = await fakeRequest(server.handle, { host: `127.0.0.1:${PORT + 2}`, path: '/api/state' });
    const { adapters, backends } = state.json.config;
    assert.deepEqual(adapters, ['mock', 'claude-code'], 'the backends that run on this computer');
    assert.deepEqual(Object.keys(backends).sort(), ['claude-code', 'codex', 'kiro-cli', 'mock']);
    assert.deepEqual(
      ['mock', 'claude-code', 'kiro-cli', 'codex'].map((n) => backends[n].local),
      [true, true, false, false],
    );
    assert.ok(backends.codex.remote, 'Codex can run on a host');
    const h = server.rt.addHost({ name: 'host.example.com' });
    assert.match(
      refused(() => server.rt.createPersona({ handle: 'near', backend: 'codex' })),
      /^“codex” isn’t available on this computer\. Available: mock, claude-code\. It can run on one of your hosts/,
    );
    assert.deepEqual(server.rt.createPersona({ handle: 'far', backend: 'codex', remote: { hostId: h.id } }).remote, { hostId: h.id });
  } finally {
    await server.close();
    await rm(own, { recursive: true, force: true });
  }
});

test('#120: an adapter a check registers after start runs on this computer, even in place of one that runs only on a host', async () => {
  const own = await mkdtemp(join(tmpdir(), 'pb-hosts-scripted-'));
  // As the browser checks start it: demo, with POSTBOX_BACKENDS=mock, then a scripted Claude Code put in.
  const server = await start({ port: PORT + 3, dataDir: own, fresh: true, demo: true, quiet: true, claudeHome: own, listen: false, hosts: null });
  try {
    server.rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
    assert.equal(server.rt.createPersona({ handle: 'scripted', backend: 'claude-code' }).backend, 'claude-code');
    // A host-only backend replaced by a scripted one runs here too; registered again as host-only, it doesn’t.
    server.rt.adapters.register({ name: 'codex', capabilities: { remote: true }, deliver: async () => {} }, { here: false });
    assert.match(
      refused(() => server.rt.createPersona({ handle: 'near', backend: 'codex' })),
      /^“codex” isn’t available on this computer\./,
    );
    server.rt.adapters.register({ name: 'codex', deliver: async () => {} });
    assert.equal(server.rt.createPersona({ handle: 'near', backend: 'codex' }).backend, 'codex');
    const state = await fakeRequest(server.handle, { host: `127.0.0.1:${PORT + 3}`, path: '/api/state' });
    assert.deepEqual(state.json.config.adapters, ['mock', 'claude-code', 'codex']);
    assert.equal(state.json.config.backends['claude-code'].local, true, 'the page sees it as local too');
  } finally {
    await server.close();
    await rm(own, { recursive: true, force: true });
  }
});
