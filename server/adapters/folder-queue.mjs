// The turns that take turns in one folder (#1709). Moved from antigravity-cli.mjs, whose adapter runs each turn through it.

import { resolve } from 'node:path';

/**
 * One turn at a time per folder: each turn’s plugin holds its own conversation’s MCP URL, so a second turn in the
 * same folder would overwrite the first’s, and the first’s cleanup would remove the second’s.
 */
export class FolderQueue {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.tails = new Map();
  }
  /** Whether a turn is running, or waiting, in the folder. */
  busy(dir) {
    return this.tails.has(resolve(dir));
  }
  /** @template T @param {string} dir @param {() => Promise<T>} fn @returns {Promise<T>} */
  async run(dir, fn) {
    const k = resolve(dir);
    const before = this.tails.get(k) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const mine = new Promise((ok) => {
      release = () => ok(undefined);
    });
    const tail = before.then(() => mine);
    this.tails.set(k, tail);
    try {
      await before;
      return await fn();
    } finally {
      release();
      if (this.tails.get(k) === tail) this.tails.delete(k);
    }
  }
}
