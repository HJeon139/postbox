// The models each backend offers, asked of its own harness when a sheet with a model field opens, instead of a list
// Postbox keeps or one read once at start. The last list each gave is kept in the data folder, so it’s what the
// backend offers after a restart, and what the field suggests when the harness can’t list just then. For an agent
// that runs on a host, the harness asked is the host’s own CLI, through its daemon (#1304), and its list is kept
// apart, per host.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { httpError } from './helpers.mjs';

/** How long a list is used before the harness is asked again. */
const FRESH_MS = 60_000;

/** @typedef {import('./remote/hosts-models.mjs').NotListed} NotListed */
/** Each reason a host gives no list (hosts-models.mjs); any other failure is not-listed. */
const WHY = ['unreachable', 'outdated', 'no-cli', 'not-listed'];

export class ModelLists {
  /**
   * @param {import('./adapters/adapter.mjs').AdapterRegistry} adapters
   * @param {{ file: string, now?: () => number, listOnHost?: (hostId: string, backend: string) => Promise<string[]>,
   *   hostIds?: () => string[] }} opts  file: where the last lists are kept; listOnHost: what a host’s CLI lists
   *   (server/remote/hosts-models.mjs); hostIds: the hosts Postbox has, so a deleted one’s lists are forgotten
   */
  constructor(adapters, { file, now = Date.now, listOnHost, hostIds }) {
    this.adapters = adapters;
    this.file = file;
    this.now = now;
    this.listOnHost = listOnHost;
    this.hostIds = hostIds;
    /** @type {Map<string, number>} when each host’s harness last listed, by `backend@hostId` */
    this.hostListedAt = new Map();
    /** @type {Map<string, Promise<{ models?: string[], why?: NotListed }>>} each host’s listing under way */
    this.hostAsking = new Map();
    // By adapter, not by name: an adapter registered again under a name is a harness to ask afresh.
    /** @type {WeakMap<object, number>} when each adapter’s harness last listed */
    this.listedAt = new WeakMap();
    /** @type {WeakMap<object, Promise<string[]>>} the listing under way for each adapter */
    this.asking = new WeakMap();
  }

  /** Offers each backend the last list its harness gave, as Postbox starts. Asks no harness. */
  seed() {
    const kept = this.#kept();
    for (const name of this.adapters.names()) if (Object.hasOwn(kept, name) && Array.isArray(kept[name])) this.#offer(name, kept[name]);
  }

  /**
   * A backend’s models, and whether its harness listed them just now (fresh) or they’re the last it listed. With a
   * hostId, the host’s, and why they’re not fresh when they aren’t.
   * @param {string} backend @param {unknown} [hostId]
   * @returns {Promise<{ models: string[], fresh: boolean, why?: NotListed }>}
   */
  async list(backend, hostId = null) {
    if (!this.adapters.names().includes(backend)) throw httpError(404, `“${String(backend).slice(0, 40)}” isn’t one Postbox runs.`);
    if (hostId !== null && (typeof hostId !== 'string' || !/^[\w-]{1,64}$/.test(hostId)))
      throw httpError(400, 'hostId must be a host’s ID, or null for this computer.');
    const adapter = this.adapters.get(backend);
    if (hostId !== null && this.hostIds && !this.hostIds().includes(hostId)) {
      for (const key of this.hostListedAt.keys()) if (key.endsWith(`@${hostId}`)) this.hostListedAt.delete(key);
      throw httpError(404, 'That host isn’t one Postbox has. Pick another under Runs on.');
    }
    if (hostId !== null) return this.#onHost(adapter, backend, hostId);
    const last = () => adapter.capabilities?.models ?? [];
    // One that runs only on a host has no CLI here to ask.
    if (typeof adapter.listModels !== 'function' || !this.adapters.runsHere(backend)) return { models: last(), fresh: false };
    const at = this.listedAt.get(adapter);
    if (at !== undefined && this.now() - at < FRESH_MS) return { models: last(), fresh: true };
    let asking = this.asking.get(adapter);
    if (!asking) {
      asking = Promise.resolve()
        .then(() => adapter.listModels())
        // A harness that throws instead of answering couldn’t list, as one that answers nothing: the field says so.
        .catch(() => [])
        .then((/** @type {string[]} */ models) => {
          if (models.length) this.#listed(adapter, backend, models);
          return models;
        })
        .finally(() => this.asking.delete(adapter));
      this.asking.set(adapter, asking);
    }
    const models = await asking;
    return models.length ? { models, fresh: true } : { models: last(), fresh: false };
  }

  /**
   * The models a backend’s harness on a host offers: asked through the adapter, so it offers what it would from its
   * CLI here (Codex adds auto), from what the host’s CLI lists.
   * @param {any} adapter @param {string} backend @param {string} hostId
   * @returns {Promise<{ models: string[], fresh: boolean, why?: NotListed }>}
   */
  async #onHost(adapter, backend, hostId) {
    const key = `${backend}@${hostId}`;
    const last = () => {
      const kept = this.#kept()[key];
      return Array.isArray(kept) ? kept : [];
    };
    // One that can’t run on a host has no harness there to ask.
    if (!adapter.capabilities?.remote || typeof adapter.listModels !== 'function' || !this.listOnHost)
      return { models: last(), fresh: false, why: 'not-listed' };
    const at = this.hostListedAt.get(key);
    if (at !== undefined && this.now() - at < FRESH_MS) return { models: last(), fresh: true };
    let asking = this.hostAsking.get(key);
    if (!asking) {
      const listOnHost = /** @type {NonNullable<typeof this.listOnHost>} */ (this.listOnHost);
      asking = Promise.resolve()
        .then(() => adapter.listModels(() => listOnHost(hostId, backend)))
        .then(
          (/** @type {string[]} */ models) => {
            if (!models.length) return { why: /** @type {NotListed} */ ('not-listed') };
            this.hostListedAt.set(key, this.now());
            this.#keep(key, models);
            return { models };
          },
          (e) => {
            if (e?.code === 'no-host') throw httpError(404, 'That host isn’t one Postbox has. Pick another under Runs on.');
            return { why: /** @type {NotListed} */ (WHY.includes(e?.code) ? e.code : 'not-listed') };
          },
        )
        .finally(() => this.hostAsking.delete(key));
      this.hostAsking.set(key, asking);
    }
    const r = await asking;
    return r.models ? { models: r.models, fresh: true } : { models: last(), fresh: false, why: r.why };
  }

  #listed(adapter, backend, models) {
    this.listedAt.set(adapter, this.now());
    adapter.capabilities = { ...adapter.capabilities, models };
    this.#keep(backend, models);
  }

  /**
   * Keeps a list in the data folder, by its key: a backend’s name, or `backend@hostId` for a host’s. Keeping it is for
   * a restart: a write that fails is logged, and the answer still has the list.
   */
  #keep(key, models) {
    try {
      const kept = { ...this.#kept(), [key]: models };
      // A deleted host’s lists go: no sheet can ask for them again.
      const hosts = this.hostIds?.();
      if (hosts) for (const k of Object.keys(kept)) if (k.includes('@') && !hosts.includes(k.slice(k.indexOf('@') + 1))) delete kept[k];
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(kept)}\n`);
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(`Postbox couldn’t keep ${key}’s models in ${this.file}: ${e instanceof Error ? e.message : e}. They’re listed again after a restart.`);
    }
  }

  /** What the backend offers: the page and the server read capabilities.models (adapter.mjs). */
  #offer(backend, models) {
    const adapter = this.adapters.get(backend);
    adapter.capabilities = { ...adapter.capabilities, models };
  }

  /** @returns {Record<string, string[]>} */
  #kept() {
    try {
      const kept = JSON.parse(readFileSync(this.file, 'utf8'));
      return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    } catch {
      return {}; // None kept yet, or a file that isn’t ours to read: every harness is asked again.
    }
  }
}
