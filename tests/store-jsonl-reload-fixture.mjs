import * as fs from 'node:fs/promises';
import { deferred, disk, handleWith } from './store-jsonl-fixture.mjs';

// An old descriptor appears to sync successfully after its first EIO. Recovery
// must open another descriptor rather than mistaking that success for a barrier.
export function recoveryDisk() {
  const entered = deferred();
  const release = deferred();
  const control = { armed: false, failedHandle: null, mode: 'hold', opens: 0, synced: [], closed: new Set(), entered, release };
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (!/events-\d+\.jsonl$/.test(String(path))) return handle;
      const id = ++control.opens;
      return handleWith(handle, {
        sync: async () => {
          if (control.armed && control.failedHandle === null) {
            control.failedHandle = id;
            await handle.sync();
            throw Object.assign(new Error('lost sync result'), { code: 'EIO' });
          }
          if (id === control.failedHandle) return;
          if (control.failedHandle !== null) {
            entered.resolve();
            if (control.mode === 'hold') await release.promise;
            if (control.mode === 'reject') throw Object.assign(new Error('recovery sync refused'), { code: 'EIO' });
          }
          await handle.sync();
          control.synced.push(id);
        },
        close: async () => {
          control.closed.add(id);
          await handle.close();
        },
      });
    },
  });
  return { io, control };
}
