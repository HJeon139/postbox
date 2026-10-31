// A close that times out keeps the folder (the 1b invariants, I3c; gpt’s repro on 1b): a snapshot rename already handed
// to the disk can’t be cancelled by a flag, so if close() released the lock at its bound, the next owner could commit
// and snapshot, and the old rename would then land over its newer snapshot and lose acknowledged history. So close()
// rejects and keeps the lock, and a second store (here a real child process, as gpt’s probe) is refused while the old
// rename is pending. Runs here because tests/guard.mjs bans spawning in the unit suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../server/store.mjs';
import { disk } from '../store-jsonl-fixture.mjs';

const storeAt = new URL('../../server/store.mjs', import.meta.url).pathname;

/** A second Postbox trying the folder from another process: prints OK with its threads, or REFUSED with the message. */
function secondStore(dir) {
  const code = `import { Store } from ${JSON.stringify(storeAt)};
    try { const b = await new Store(${JSON.stringify(dir)}).load(); await b.commit([{ type: 'thread', data: { id: 'acknowledged-by-b', members: [] } }]); await b.snapshot(); await b.close(); console.log('OK'); }
    catch (e) { console.log('REFUSED ' + e.message); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  return new Promise((r) => child.once('exit', () => r(out.trim())));
}

test('close() at its bound with a snapshot rename pending keeps the lock: a child store is refused, and the restart has every acknowledged event', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pb-close-handoff-'));
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  let entered;
  const atRename = new Promise((r) => {
    entered = r;
  });
  const io = disk({
    async rename(from, to) {
      if (String(to).endsWith('snapshot.json')) {
        entered();
        await held; // the rename is handed to the disk, past every retiring check, and doesn’t answer
      }
      return fs.rename(from, to);
    },
  });
  const a = await new Store(dir, { io, retryBoundMs: 40 }).load();
  await a.commit([{ type: 'thread', data: { id: 'before', members: [] } }], { opId: 'before' });
  const snapshot = a.snapshot();
  await atRename;
  await assert.rejects(a.close(), /can’t close.*Stop the process/);
  assert.ok(a.lock, 'the lock is kept while the rename is pending');
  assert.match(await secondStore(dir), /^REFUSED Another Postbox store \(process \d+\) holds/);
  release();
  await snapshot.catch(() => {}); // the old rename lands on A’s own folder: nothing newer was there to overwrite
  // The process exit is what releases the lock; here the test stands in for it.
  await fs.rm(join(dir, 'store.lock'), { force: true });
  const c = await new Store(dir).load();
  assert.deepEqual(Object.keys(c.state.threads), ['before'], 'nothing acknowledged was lost, and nothing unacknowledged appeared');
  await c.close();
  await fs.rm(dir, { recursive: true, force: true });
});
