// A headless Chrome check of the UAT runner’s host-mode driver (#120; tools/uat/driver-hosts.mjs), against the real
// Hosts tab and persona sheet: add a host, set its settings and the project’s folder there, Install through its
// confirm (from the card’s Install… and, for a host just added with no status, from the confirm the runner opens),
// put an agent on it in Runs on, and Remove it through its confirm. The live run can’t be tried
// here, so this is what shows the driver’s selectors still match the page.
//
//   node tools/check-uat-hosts.mjs
//
// It starts its own fresh Postbox with a fake host manager (no ssh, no host): a host has no status until something
// sets one, as the real manager’s doesn’t, and installing makes it Disconnected. PB_PORT and PB_CHROME_PORT move it (4920 and 9520 by default). It reports through tools/harness.mjs.

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { describeInstall } from '../server/remote/install.mjs';
import { launch } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';
import { driver } from './uat/driver.mjs';
import { addHost, closeAll, editHost, install, placePersona, removeHost } from './uat/driver-hosts.mjs';

const { PORT, CHROME_PORT } = await ports(4920, 9520);
const VERSION = '0.24.0';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-uat-hosts-'));
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
  }
  set(id, status) {
    this.statuses.set(id, { failure: null, welcome: null, lastHeard: null, ...status });
    this.emit('status', id, this.statuses.get(id));
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  link(id) {
    return Object.assign(new EventEmitter(), {
      connected: this.statuses.get(id)?.state === 'connected',
      send: () => false,
      retry: () => {
        this.calls.push(['retry', id]);
        this.set(id, { state: 'connected', welcome: WELCOME, lastHeard: Date.now() });
      },
    });
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
const none = async () => null;
const nothing = async () => [];
const app = await start({
  port: PORT,
  dataDir,
  fresh: true,
  quiet: true,
  claudeHome: dataDir,
  hosts: /** @type {any} */ (fake),
  probes: { claude: async () => '2.1.308', sdk: none, kiro: none, kiroModels: nothing, agy: none, agyModels: nothing, codex: none, codexModels: nothing },
});
app.store.emit('project', { id: 'pr_uat', name: 'Line counter', folder: dataDir });
const coder = app.rt.createPersona({ handle: 'coder', backend: 'claude-code' });
const page = await launch({ port: CHROME_PORT });

/** Runs one case, recording a throw as its failure. */
async function step(name, fn) {
  try {
    const r = await fn();
    check(r !== false, name);
  } catch (e) {
    check(false, name, e.stack ?? String(e));
    await closeAll(kit).catch(() => {});
  }
}

const kit = driver(page).kit;
const S = () => app.store.state;
try {
  await page.size(1280, 900);
  await page.goto(`${app.origin}/`);
  await page.waitFor(`!!document.querySelector('.app')`, { label: 'the app' });
  let id = '';
  await step('addHost adds a host through Add a host, and finds its card', async () => {
    id = await addHost(kit, 'host.example.com');
    return S().hosts[id]?.name === 'host.example.com';
  });
  await step('editHost sets durations, numbers, checkboxes, paths and the project’s folder, and saves', async () => {
    const settings = { idleTimeout: 60_000, claudePath: '/home/user/tools/bin/claude', keepAlive: { count: 5, interval: 10_000 }, denyPrompts: true };
    await editHost(kit, id, settings, { project: 'pr_uat', folder: '/home/user/postbox-uat/run' });
    const s = S().hosts[id].settings;
    const got = [s.idleTimeout, s.claudePath, s.keepAlive.count, s.keepAlive.interval, s.denyPrompts, S().projects.pr_uat.hostFolders?.[id]];
    check(
      JSON.stringify(got) === JSON.stringify([60_000, '/home/user/tools/bin/claude', 5, 10_000, true, '/home/user/postbox-uat/run']),
      'each setting landed as given',
      JSON.stringify(got),
    );
  });
  await step('editHost throws with the editor’s own refusal', async () => {
    const refused = await editHost(kit, id, { claudePath: 'claude' }).then(
      () => null,
      (e) => e.message,
    );
    await closeAll(kit);
    check(/must be an absolute path on the host/.test(String(refused)), 'the refusal is the editor’s', String(refused));
  });
  await step('a host just added has no Install…, so install() opens the confirm, reads it, and installs', async () => {
    const shown = await install(kit, id);
    const expected = describeInstall(S().hosts[id], { version: VERSION, dataDir }).text;
    check(shown.installOffered === false && /Not connected yet/.test(shown.card), 'it says the card offered no Install…', JSON.stringify(shown.card));
    check(shown.confirm === expected && shown.commands.length > 0, 'it read the confirm’s text and commands', shown.confirm);
    return fake.calls.some((c) => c[0] === 'install' && c[1] === id);
  });
  let id2 = '';
  await step('a host whose card offers Install… is installed from it', async () => {
    id2 = await addHost(kit, 'build.example.com');
    fake.set(id2, { state: 'not-installed' });
    return (await install(kit, id2)).installOffered === true;
  });
  await step('placePersona sets an agent’s Runs on to a host, and back to this computer', async () => {
    await placePersona(kit, 'coder', id);
    check(S().personas[coder.id].remote?.hostId === id, 'Runs on the host');
    await placePersona(kit, 'coder', null);
    return !S().personas[coder.id].remote;
  });
  await step('removeHost reads the confirm, removes the host there and here, and its card goes', async () => {
    const confirm = await removeHost(kit, id2);
    check(/deletes ~\/\.postbox-remote there/.test(confirm), 'the confirm says what it deletes', confirm);
    return !S().hosts[id2] && fake.calls.some((c) => c[0] === 'removeFromHost' && c[1] === id2);
  });
  const errors = page.logs.filter((l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED|status of 422 .*\/api\/hosts\//.test(l));
  check(!errors.length, 'no errors in the browser console', errors.join('\n'));
} finally {
  await page.close().catch(() => {});
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
