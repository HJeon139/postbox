// What the Hosts tab specs share (#120): a Postbox with a fake host manager in place of server/remote/hosts.mjs, so
// nothing connects to a host (a spec sets each status the manager would report, and reads what the page asked of it),
// the tab opened in Settings, and what each step checks: axe, and nothing in a dialog running off the window. Moved
// from tools/hosts-check.mjs (#303).

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { describeInstall } from '../../server/remote/install.mjs';
import { failure } from '../../server/remote/ssh.mjs';
import { startPostbox, synced, windowWidth } from './postbox.mjs';

export const VERSION = '0.18.0';
export const MINUTE = 60_000;
/** The widths each Hosts test runs at, a phone’s emulated. */
export const SIZES = [
  { width: 1280, use: { viewport: { width: 1280, height: 900 } } },
  { width: 375, use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
];

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** The host manager’s shape, as the runtime uses it, with each status set by the spec. */
export class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** The Postbox it serves, set once it starts. @type {any} */
    this.app = null;
    this.reset();
  }
  /** Forgets what the last test asked and set. */
  reset() {
    /** @type {any[]} */
    this.calls = [];
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** What install rejects with. @type {Error | null} */
    this.installError = null;
    /** Hosts this computer has no token for. @type {Set<string>} */
    this.noToken = new Set();
    /** What removeFromHost rejects with, in place of the daemon’s `removed`. @type {Error | null} */
    this.removeError = null;
  }
  host(id) {
    return this.app.store.state.hosts[id];
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
    if (this.noToken.has(id)) throw Object.assign(failure('not-installed', this.host(id).name), { code: 'not-installed' });
    return Object.assign(new EventEmitter(), { connected: false, send: () => false });
  }
  /** The person’s Retry, Reconnect or Take over. */
  async connect(id, o) {
    this.calls.push(['connect', id, o]);
  }
  describeInstall(id) {
    return describeInstall(this.host(id), { version: VERSION, dataDir: join(this.app.root, 'data') });
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
    if (this.noToken.has(id)) throw Object.assign(failure('not-installed', this.host(id).name), { code: 'not-installed' });
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

/** Starts a spec’s Postbox with a fake host manager. @param {string} name */
export async function startHosts(name) {
  const fake = new FakeHosts();
  const app = await startPostbox(name, { server: { hosts: fake } });
  fake.app = app;
  return { app, fake };
}

/**
 * Starts a test with no hosts and nothing asked of the manager, then one host named that, as Add host leaves it.
 * @param {any} app @param {FakeHosts | null} fake  null: the real manager @param {string} [name]  none: no host
 */
export function freshHost(app, fake, name) {
  fake?.reset();
  for (const id of Object.keys(app.store.state.hosts ?? {})) app.store.emit('host', { id, removed: true });
  return name ? app.rt.addHost({ name }).id : '';
}

/**
 * Opens Settings at its Hosts tab, once the page has heard everything the server did, and returns the dialog.
 * @param {import('@playwright/test').Page} page @param {any} app
 */
export async function openHosts(page, app) {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('tab', { name: 'Hosts' })).toHaveAttribute('aria-selected', 'true');
  return settings;
}

/** A host’s card in the tab, named for the host. @param {import('@playwright/test').Page} page @param {string} name */
export const card = (page, name) => page.getByRole('region', { name, exact: true });

/**
 * At this step, nothing in a dialog runs off the window, and axe finds nothing on the page against WCAG 2.1 A and AA.
 * Soft, so one step’s finding doesn’t hide the next’s.
 * @param {import('@playwright/test').Page} page @param {string} where
 */
export async function audit(page, where) {
  const width = windowWidth(page);
  const wide = await page.evaluate(
    (w) =>
      [...document.querySelectorAll('.dialog *')]
        .filter((el) => el.getBoundingClientRect().right > w + 1 && /** @type {HTMLElement} */ (el).offsetParent !== null)
        .map((el) => `${el.tagName}.${el.className}`)
        .slice(0, 3),
    width,
  );
  expect.soft(wide, `${where}: nothing runs off the window at ${width} px`).toEqual([]);
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover, as a tag it loads would be.
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(`${AXE};0`);
  const found = await page.evaluate(() =>
    /** @type {any} */ (window).axe
      .run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
      .then((r) =>
        r.violations.map(
          (v) =>
            `${v.id}: ${v.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join(', ')}`,
        ),
      ),
  );
  expect.soft(found, `${where}: axe at ${width} px`).toEqual([]);
}
