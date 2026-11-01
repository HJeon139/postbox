// Shared by the 1b store specs (tests/store-retry.test.mjs, tests/store-failure-policy.test.mjs): a disk whose event-log
// handles answer to injected faults, and the small builders they use.
import * as realFs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

export const tmp = () => mkdtemp(join(tmpdir(), 'pb-retry-'));
export const thread = (id) => ({ type: 'thread', data: { id, members: [] } });
export const eio = (what) => Object.assign(new Error(what), { code: 'EIO' });

/** A disk whose event-log handles answer to `faults`: { sync?, write? } are called before the real operation. */
export function logDisk(faults) {
  return disk({
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode);
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

/**
 * A hold for a fault: the operation awaits `promise` until release(); `reached` resolves when it got there. A spec waits
 * for `reached` before it acts, instead of a fixed time: under load a Retry may not have arrived yet, and close()’s
 * boundary would make it give way earlier, by design (the barrier spec flaked 1 in 108 for that reason).
 */
export function hold() {
  let release = () => {};
  let arrived = () => {};
  const promise = new Promise((r) => {
    release = () => r(undefined);
  });
  const reached = new Promise((r) => {
    arrived = () => r(undefined);
  });
  return {
    promise,
    release,
    reached,
    /** The fault: marks the arrival, then waits. */
    wait: () => {
      arrived();
      return promise;
    },
  };
}
