// What the specs of agents on remote hosts (#120) share: a Postbox with a fake host manager, so no ssh, no host and
// no daemon (each host’s status is set by the spec, as the real manager reports it), Claude Code on this computer by a
// fake probe, and Kiro CLI and Codex only on a host. Also axe, and what sticks out of the window. Moved from the
// setup of tools/check-remote-ui.mjs and tools/remote-turns-kit.mjs (#303).

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startPostbox, windowWidth } from './postbox.mjs';

/** The host manager, as the runtime uses it: each host’s status is what the spec sets, and its link takes anything. */
export class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Map<string, any>} */
    this.links = new Map();
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  set(id, status) {
    this.statuses.set(id, status);
    this.emit('status', id, status);
  }
  link(id) {
    if (!this.links.has(id)) this.links.set(id, Object.assign(new EventEmitter(), { connected: true, send: () => true }));
    return this.links.get(id);
  }
  async connect(id) {
    return this.statuses.get(id)?.welcome ?? null;
  }
  async ensureWelcome(id) {
    return this.statuses.get(id)?.welcome ?? { home: '/home/user', turns: [] };
  }
  async signInCheck() {
    return null;
  }
  describeInstall() {
    return { destination: 'host.example.com', steps: [], text: '' };
  }
  async install() {
    return { token: 'T'.repeat(43), installed: true, version: '0.18.0' };
  }
  need() {}
  release() {}
  wake() {}
  async forget() {
    return true;
  }
  async refresh() {
    return false;
  }
  destinationOf(id) {
    return this.statuses.get(id)?.name ?? null;
  }
  async close() {}
}

const none = async () => null;
const nothing = async () => [];
/** Claude Code is on this computer; Kiro CLI, Codex and the rest aren’t, so they can run only on a host. */
const PROBES = { claude: async () => '2.1.300', sdk: none, kiro: none, kiroModels: nothing, agy: none, agyModels: nothing, codex: none, codexModels: nothing };

/**
 * Starts a fresh Postbox without the demo, with a fake host manager and fake probes, for one spec file.
 * @param {string} name  a short name for its temp folder
 */
export async function startRemote(name) {
  const hosts = new FakeHosts();
  const app = await startPostbox(name, { demo: false, server: { hosts: /** @type {any} */ (hosts), probes: PROBES } });
  return { app, hosts };
}

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/**
 * What axe finds in the page against WCAG 2.1 A and AA, one line each.
 * @param {import('@playwright/test').Page} page
 */
export async function axe(page) {
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover, as a tag it loads would be.
  await page.evaluate(`${AXE};0`);
  return page.evaluate(() =>
    /** @type {any} */ (window).axe
      .run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
      .then((r) =>
        r.violations.map(
          (v) =>
            `${v.id}: ${v.help} (${v.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join('; ')})`,
        ),
      ),
  );
}

/**
 * What a selector finds that shows and runs past the window’s sides, and the page itself when it scrolls sideways.
 * The width is the test’s (windowWidth): on a phone, a page that overflows widens innerWidth to fit.
 * @param {import('@playwright/test').Page} page  @param {string} selector
 */
export const overflowing = (page, selector) =>
  page.evaluate(
    ([sel, w]) => {
      const out = [...document.querySelectorAll(sel)]
        .filter((n) => {
          const b = n.getBoundingClientRect();
          return b.width && /** @type {HTMLElement} */ (n).offsetParent !== null && (b.right > w + 1 || b.left < -1);
        })
        .map((n) => `${n.tagName}.${n.className}`);
      const d = document.documentElement;
      if (d.scrollWidth > w + 1) out.push(`the page, by ${d.scrollWidth - w} px`);
      return out;
    },
    /** @type {const} */ ([selector, windowWidth(page)]),
  );
