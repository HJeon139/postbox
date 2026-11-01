import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';

export const event = (seq, id) => ({ seq, type: 'thread', data: { id, members: [] } });
export const line = (value) => `${JSON.stringify(value)}\n`;
export const eventsIn = (text) => {
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
};
const stores = new Map();

export async function folder(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pb-jsonl-spec-'));
  stores.set(dir, []);
  t.after(async () => {
    try {
      for (const store of stores.get(dir)) {
        if (store.close) await store.close();
        else await store.flush();
      }
    } finally {
      stores.delete(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  return dir;
}

export async function opened(_t, dir, options = {}) {
  const store = await new Store(dir, { snapshotEvery: Infinity, ...options }).load();
  stores.get(dir).push(store);
  return store;
}

export async function image(t, source) {
  const dir = await folder(t);
  for (const name of await fs.readdir(source)) {
    if (name === 'snapshot.json' || /^events-\d+\.jsonl$/.test(name)) {
      await fs.copyFile(join(source, name), join(dir, name));
    }
  }
  return dir;
}

// The proposed Store { io } option uses the real filesystem by default. Tests replace
// only an operation at the fault boundary; bytes still go to a disposable data folder.
export function disk(overrides = {}) {
  return { ...fs, ...overrides };
}

export function handleWith(handle, overrides) {
  return new Proxy(handle, {
    get(target, key) {
      if (key in overrides) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function waiting(promise, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}.`)), 3000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A disk whose event-log handles answer to `faults`: { sync?, write? } are called before the real operation. */
export function logDisk(faults) {
  return disk({
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (!String(path).includes('events-')) return handle;
      return handleWith(handle, {
        sync: async () => {
          if (faults.sync) await faults.sync();
          return handle.sync();
        },
        write: async (...args) => {
          if (faults.write) return faults.write(handle, ...args);
          return handle.write(...args);
        },
      });
    },
  });
}
