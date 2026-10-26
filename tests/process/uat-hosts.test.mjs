// The UAT runner’s host-mode driver (#120; tools/uat/driver-hosts.mjs) against the real Hosts tab and persona sheet:
// add a host, set its settings and the project’s folder there, Install through its confirm (from the card’s Install…
// and, for a host just added with no status, from the confirm the runner opens), put an agent on it in Runs on, and
// Remove it through its confirm. The live run can’t be tried here, so this is what shows the driver’s selectors still
// match the page. The driver is the UAT runner’s own code on tools/browser.mjs, not a Playwright spec, so this
// starts Chromium as the runner does, and is under tests/process/ (npm run test:process).
// It starts its own fresh Postbox with a fake host manager (no ssh, no host): a host just added is not installed, as
// the real manager says of one with no token here, unless `quiet` holds its status back (as a Postbox before that fix
// did, which the driver still copes with); installing makes it Disconnected. Moved from tools/check-uat-hosts.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { start } from '../../server/index.mjs';
import { describeInstall } from '../../server/remote/install.mjs';
import { chromiumMissing, freePort } from './chrome.mjs';

const skip = await chromiumMissing();
const VERSION = '0.24.0';
const WELCOME = {
  version: VERSION,
  home: '/home/user',
  node: { version: '22.12.0', path: '/home/user/.local/share/mise/installs/node/22.12.0/bin/node' },
  harnesses: [{ name: 'claude-code', path: '/home/user/tools/bin/claude', version: '2.1.308' }],
  problems: [],
  turns: [],
};

/** The host manager as the runtime uses it, with what each step of the driver asks of it recorded. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} */
    this.calls = [];
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** No status for a host until one is set. */
    this.quiet = false;
  }
  set(id, status) {
    this.statuses.set(id, { failure: null, welcome: null, lastHeard: null, ...status });
    this.emit('status', id, this.statuses.get(id));
  }
  status(id) {
    const fresh = !this.quiet && app.store.state.hosts?.[id] ? { state: 'not-installed', failure: null, welcome: null, lastHeard: null } : null;
    return this.statuses.get(id) ?? fresh;
  }
  link(id) {
    return Object.assign(new EventEmitter(), { connected: this.statuses.get(id)?.state === 'connected', send: () => false });
  }
  /** The person’s Retry or Reconnect, which connects as the manager’s does. */
  async connect(id) {
    this.calls.push(['connect', id]);
    this.set(id, { state: 'connected', welcome: WELCOME, lastHeard: Date.now() });
    return WELCOME;
  }
  describeInstall(id) {
    return describeInstall(app.store.state.hosts[id], { version: VERSION, dataDir });
  }
  async install(id) {
    this.calls.push(['install', id]);
    this.set(id, { state: 'disconnected' });
    return { token: 'T'.repeat(43), installed: true, version: VERSION };
  }
  async removeFromHost(id) {
    this.calls.push(['removeFromHost', id]);
  }
  async forget(id) {
    this.calls.push(['forget', id]);
    return true;
  }
  async refresh() {
    return false;
  }
  async ensureWelcome() {
    return WELCOME;
  }
  async signInCheck() {
    return null;
  }
  destinationOf() {
    return null;
  }
  wake() {}
  need() {}
  release() {}
  close() {}
}

const fake = new FakeHosts();
let dataDir = '';
/** @type {any} */
let app;
/** @type {any} */
let page;
/** @type {any} */
let kit;
/** @type {typeof import('../../tools/uat/driver-hosts.mjs')} */
let hosts;
let coder;
const S = () => app.store.state;
const called = (what, id) => fake.calls.some((c) => c[0] === what && c[1] === id);

before(async () => {
  if (skip) return;
  const { launch } = await import('../../tools/browser.mjs');
  const { driver } = await import('../../tools/uat/driver.mjs');
  hosts = await import('../../tools/uat/driver-hosts.mjs');
  dataDir = await mkdtemp(join(tmpdir(), 'pb-test-uat-hosts-'));
  const none = async () => null;
  const nothing = async () => [];
  const probes = {
    claude: async () => '2.1.308',
    sdk: none,
    kiro: none,
    kiroModels: nothing,
    agy: none,
    agyModels: nothing,
    codex: none,
    codexModels: nothing,
  };
  const port = await freePort();
  app = await start({ port, dataDir, fresh: true, quiet: true, claudeHome: dataDir, hosts: /** @type {any} */ (fake), probes });
  app.store.emit('project', { id: 'pr_uat', name: 'Line counter', folder: dataDir });
  coder = app.rt.createPersona({ handle: 'coder', backend: 'claude-code' });
  page = await launch();
  kit = driver(page).kit;
  await page.size(1280, 900);
  await page.goto(`${app.origin}/`);
  await page.waitFor(`!!document.querySelector('.app')`, { label: 'the app' });
});
after(async () => {
  await page?.close().catch(() => {});
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** One step of the story, in order, on the one page; a step that fails closes what it left open, as the driver does. */
const step = (name, fn) =>
  test(name, { skip }, async () => {
    try {
      await fn();
    } catch (e) {
      await hosts.closeAll(kit).catch(() => {});
      throw e;
    }
  });

let id = '';
let id2 = '';
step('addHost adds a host through Add a host, and finds its card', async () => {
  id = await hosts.addHost(kit, 'host.example.com');
  assert.equal(S().hosts[id]?.name, 'host.example.com');
});

step('editHost sets durations, numbers, checkboxes, paths and the project’s folder, and saves', async () => {
  const settings = { idleTimeout: 60_000, claudePath: '/home/user/tools/bin/claude', keepAlive: { count: 5, interval: 10_000 }, denyPrompts: true };
  await hosts.editHost(kit, id, settings, { project: 'pr_uat', folder: '/home/user/postbox-uat/run' });
  const s = S().hosts[id].settings;
  const got = [s.idleTimeout, s.claudePath, s.keepAlive.count, s.keepAlive.interval, s.denyPrompts, S().projects.pr_uat.hostFolders?.[id]];
  assert.deepEqual(got, [60_000, '/home/user/tools/bin/claude', 5, 10_000, true, '/home/user/postbox-uat/run'], 'each setting landed as given');
});

step('editHost throws with the editor’s own refusal', async () => {
  await assert.rejects(hosts.editHost(kit, id, { claudePath: 'claude' }), /must be an absolute path on the host/, 'the refusal is the editor’s');
  await hosts.closeAll(kit);
});

step('a host just added offers Install…, so install() presses it, reads the confirm, and installs', async () => {
  const shown = await hosts.install(kit, id);
  const expected = describeInstall(S().hosts[id], { version: VERSION, dataDir }).text;
  assert.equal(shown.installOffered, true, 'the card offered Install…');
  assert.match(shown.card, /Not installed/, 'the card said it’s not installed');
  assert.equal(shown.confirm, expected, 'it read the confirm’s text');
  assert.ok(shown.commands.length > 0, 'it read the confirm’s commands');
  assert.ok(called('install', id), 'it installed');
});

step('a host with no status has no Install…, so install() opens the confirm itself, and says so', async () => {
  fake.quiet = true;
  try {
    id2 = await hosts.addHost(kit, 'build.example.com');
    const shown = await hosts.install(kit, id2);
    assert.match(shown.card, /Not connected yet/, 'its card had no status');
    assert.equal(shown.installOffered, false);
    assert.ok(called('install', id2), 'it installed');
  } finally {
    fake.quiet = false;
  }
});

step('placePersona sets an agent’s Runs on to a host, and back to this computer', async () => {
  await hosts.placePersona(kit, 'coder', id);
  assert.equal(S().personas[coder.id].remote?.hostId, id, 'Runs on the host');
  await hosts.placePersona(kit, 'coder', null);
  assert.ok(!S().personas[coder.id].remote, 'Runs on this computer');
});

step('removeHost reads the confirm, removes the host there and here, and its card goes', async () => {
  const confirm = await hosts.removeHost(kit, id2);
  assert.match(confirm, /deletes ~\/\.postbox-remote there/, 'the confirm says what it deletes');
  assert.ok(!S().hosts[id2], 'removed here');
  assert.ok(called('removeFromHost', id2), 'removed there');
});

test('no errors in the browser console', { skip }, () => {
  // The event stream ends as the page goes, and the refused edit above answers 422.
  const errors = page.logs.filter((l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED|status of 422 .*\/api\/hosts\//.test(l));
  assert.deepEqual(errors, []);
});
