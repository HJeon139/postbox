// The models each backend offers, asked of its own harness when a sheet with a model field opens, instead of a list
// Postbox keeps or one read once at start. The last list each gave is kept in the data folder, so it’s what the
// backend offers after a restart, and what the field suggests when the harness can’t list just then.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { httpError } from './helpers.mjs';

/** How long a list is used before the harness is asked again. */
const FRESH_MS = 60_000;

export class ModelLists {
  /**
   * @param {import('./adapters/adapter.mjs').AdapterRegistry} adapters
   * @param {{ file: string, now?: () => number }} opts  file: where the last lists are kept
   */
  constructor(adapters, { file, now = Date.now }) {
    this.adapters = adapters;
    this.file = file;
    this.now = now;
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
   * A backend’s models, and whether its harness listed them just now (fresh) or they’re the last it listed.
   * @param {string} backend
   * @returns {Promise<{ models: string[], fresh: boolean }>}
   */
  async list(backend) {
    if (!this.adapters.names().includes(backend)) throw httpError(404, `“${String(backend).slice(0, 40)}” isn’t one Postbox runs.`);
    const adapter = this.adapters.get(backend);
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

  #listed(adapter, backend, models) {
    this.listedAt.set(adapter, this.now());
    adapter.capabilities = { ...adapter.capabilities, models };
    const kept = { ...this.#kept(), [backend]: models };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(kept)}\n`);
    renameSync(tmp, this.file);
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
