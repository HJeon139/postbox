// What tools/check-hosts.mjs and tools/check-hosts-status.mjs drive the Hosts tab of Settings (#120) with: their own
// fresh Postbox (demo mode) with a fake host manager in place of server/remote/hosts.mjs, so nothing connects to a
// host (each check sets each status the manager would report, and records what the page asks of it), and the page,
// with axe and a check that nothing runs off the window at 375 and 1280 px. PB_PORT and PB_CHROME_PORT move the ports
// (4500 and 9700 by default). They report through tools/harness.mjs.

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { describeInstall } from '../server/remote/install.mjs';
import { failure } from '../server/remote/ssh.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4500, 9700);
export const VERSION = '0.18.0';
export const MINUTE = 60_000;
export const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-hosts-'));

/** The host manager’s shape, as the runtime uses it, with each status set by the check. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} */
    this.calls = [];
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Error | null} */
    this.installError = null;
    /** Hosts this computer has no token for. @type {Set<string>} */
    this.noToken = new Set();
    /** What removeFromHost rejects with, in place of the daemon’s `removed`. @type {Error | null} */
    this.removeError = null;
  }
  /** Sets a host’s status and says so, as the manager does at each change. @param {string} id @param {any} status */
  set(id, status) {
    this.statuses.set(id, { failure: null, welcome: null, lastHeard: null, ...status });
    this.emit('status', id, this.statuses.get(id));
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  link(id) {
    if (this.noToken.has(id)) throw Object.assign(failure('not-installed', app.store.state.hosts[id].name), { code: 'not-installed' });
    return Object.assign(new EventEmitter(), { connected: false, send: () => false });
  }
  /** The person’s Retry, Reconnect or Take over. */
  async connect(id, o) {
    this.calls.push(['connect', id, o]);
  }
  describeInstall(id) {
    return describeInstall(app.store.state.hosts[id], { version: VERSION, dataDir });
  }
  async install(id) {
    this.calls.push(['install', id]);
    if (this.installError) throw this.installError;
    return { token: 'T'.repeat(43), installed: true, version: VERSION };
  }
  async forget(id) {
    this.calls.push(['forget', id]);
    return true;
  }
  async removeFromHost(id) {
    this.calls.push(['removeFromHost', id]);
    if (this.noToken.has(id)) throw Object.assign(failure('not-installed', app.store.state.hosts[id].name), { code: 'not-installed' });
    if (this.removeError) throw this.removeError;
  }
  async refresh() {
    return false;
  }
  wake() {}
  need() {}
  release() {}
  async ensureWelcome() {
    throw failure('unreachable', 'host.example.com');
  }
  async signInCheck() {
    return null;
  }
  close() {}
}

export const fake = new FakeHosts();
export const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome: dataDir, hosts: fake });

// axe, as tools/shoot-app.mjs runs it: WCAG 2.1 A and AA.
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8').catch(() => null);
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => v.id + ' (' + v.impact + '): ' + v.help + ' at ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')))`;

/** @type {any} */
export let page = null;

/** Opens Postbox in Chrome at 1280 px, with axe ready. */
export async function begin() {
  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900);
  await page.goto(`${app.origin}/`);
  await page.waitFor(`!!document.querySelector('.app')`, { label: 'the app' });
  if (AXE) await page.evaluate(`${AXE};0`);
  else check(false, 'axe-core is installed', 'Run npm install.');
}

export const js = JSON.stringify;
export const q = (sel) => `document.querySelector(${js(sel)})`;
export const text = (sel) => page.evaluate(`${q(sel)}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
export const click = (sel) => page.evaluate(`(${q(sel)}).click()`);
/** Types into a field as a person would: its value, then input and change. */
export const type = (sel, value) =>
  page.evaluate(`(() => { const el = ${q(sel)}; el.focus(); el.value = ${js(value)};
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
export const waitFor = (expr, label) => page.waitFor(expr, { label });
export const until = async (fn, ms = 4000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await sleep(50);
  return fn();
};
/** What a dialog on top says, and whether it fits the window. */
export const top = () =>
  page.evaluate(`(() => { const d = [...document.querySelectorAll('.dialog')].at(-1); if (!d) return null; const r = d.getBoundingClientRect();
    return { title: d.querySelector('.title')?.textContent ?? '', text: d.textContent.replace(/\\s+/g, ' '), role: d.getAttribute('role'), fits: r.left >= 0 && r.right <= innerWidth + 1 }; })()`);
/** axe, and nothing wider than the window, at both widths; back at 1280 after. */
export const audit = async (label) => {
  for (const [w, ht] of [
    [375, 812],
    [1280, 900],
  ]) {
    await page.size(w, ht);
    await sleep(250);
    const wide = await page.evaluate(
      `[...document.querySelectorAll('.dialog *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && el.offsetParent !== null).map((el) => el.tagName + '.' + el.className).slice(0, 3)`,
    );
    check(!wide.length, `${label}: nothing runs off the window at ${w} px`, wide.join(', '));
    if (AXE) {
      const v = await page.evaluate(AXE_RUN);
      check(!v.length, `${label}: no axe violations at ${w} px`, v.join('\n'));
    }
  }
};

/** No errors in the browser console, but for the refusals a check asks for: a failed install (502), a refused removal (409). */
export function consoleClean() {
  const errors = page.logs.filter((l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED|status of (?:502|409) .*\/api\/hosts\//.test(l));
  check(!errors.length, 'no errors in the browser console', errors.join('\n'));
}

/** Closes the page and Postbox, removes the data folder, and reports. */
export async function end() {
  await page?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  finish();
}
