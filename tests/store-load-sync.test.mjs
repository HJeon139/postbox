// What load() and the refusals say and do (#508’s storage design, “The data-folder lock”, “Recovery”; the integrator’s
// re-review of 1a, the nits without a spec): the stale-lock refusal names the file to remove; the folder is synced once
// at every load, and a filesystem that can’t sync a folder is tolerated there and at every rename alike; the store.json
// migration syncs the folder; a damaged line is refused with its byte offset; --fresh deletes nothing under another’s lock.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { lockStore } from '../server/store-lock.mjs';
import { disk, line } from './store-jsonl-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-load-'));
/** A disk that counts folder syncs, and can make them fail with `code`. */
function dirSyncs(counter, code = null) {
  return disk({
    async open(path, flags, mode) {
      const handle = await disk().open(path, flags, mode);
      if (flags !== 'r' || !(await handle.stat()).isDirectory()) return handle;
      return new Proxy(handle, {
        get: (t, k) =>
          k === 'sync'
            ? async () => {
                counter.n++;
                if (code) throw Object.assign(new Error(`fsync ${code}`), { code });
                return t.sync();
              }
            : typeof t[k] === 'function'
              ? t[k].bind(t)
              : t[k],
      });
    },
  });
}

test('a live holder’s refusal names the lock file to remove if no Postbox is running', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  await assert.rejects(
    new Store(dir).load(),
    /Another Postbox store \(process \d+\) holds .*\. Stop it first.*If no Postbox is running on it, remove .*store\.lock and start again\./,
  );
  await a.close();
  await rm(dir, { recursive: true });
});

test('load() syncs the folder once, after recovery; a filesystem that can’t sync a folder is tolerated at load and at a rotation alike', async () => {
  const dir = await tmp();
  const counter = { n: 0 };
  const a = await new Store(dir, { io: dirSyncs(counter) }).load();
  assert.equal(counter.n, 1, 'one folder sync at load');
  await a.close();
  const einval = { n: 0 };
  const b = await new Store(dir, { io: dirSyncs(einval, 'EINVAL'), snapshotEvery: 1 }).load();
  assert.equal(einval.n, 1, 'the sync was attempted and its EINVAL tolerated');
  b.emit('thread', { id: 't1', members: [] });
  await b.flush(); // the first commit into a fresh segment, and the snapshot that follows, sync the folder too
  await b.snapshot();
  assert.ok(einval.n >= 2, `the later folder syncs were attempted (${einval.n}) and tolerated: the store stayed open`);
  assert.equal(b.writable, true, 'EINVAL on a folder sync never closes the store');
  await b.close();
  const eio = { n: 0 };
  await assert.rejects(new Store(dir, { io: dirSyncs(eio, 'EIO') }).load(), /EIO/, 'any other error refuses the start');
  assert.ok(!(await readdir(dir)).includes('store.lock'), 'the refused start left no lock');
  await rm(dir, { recursive: true });
});

test('the store.json migration writes the snapshot, renames the old file aside and syncs the folder', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'store.json'), JSON.stringify({ threads: { old: { id: 'old', members: [] } } }));
  const counter = { n: 0 };
  const a = await new Store(dir, { io: dirSyncs(counter) }).load();
  assert.ok(a.state.threads.old, 'the old store’s state is read');
  const names = (await readdir(dir)).sort();
  assert.ok(names.includes('snapshot.json') && names.includes('store.json.migrated') && !names.includes('store.json'), names.join());
  assert.equal(counter.n, 2, 'one folder sync for the migration’s renames, one for the load');
  await a.close();
  await rm(dir, { recursive: true });
});

test('a damaged line is refused naming the file, the line and its byte offset', async () => {
  const dir = await tmp();
  const good = line({ seq: 1, type: 'thread', data: { id: 't1', members: [] } });
  await writeFile(join(dir, 'events-1.jsonl'), `${good}{"seq":2,"type":"thread"\n`);
  await assert.rejects(new Store(dir).load(), new RegExp(`line 2 of events-1\\.jsonl \\(byte ${Buffer.byteLength(good)}\\)`));
  await rm(dir, { recursive: true });
});

test('--fresh deletes nothing while another store holds the folder: it is refused first', async () => {
  const dir = await tmp();
  const a = await new Store(dir).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  await assert.rejects(new Store(dir).load({ fresh: true }), /Another Postbox store/);
  assert.ok((await readFile(join(dir, 'events-1.jsonl'), 'utf8')).includes('t1'), 'the running store’s log is untouched');
  await a.close();
  const lock = await lockStore(disk(), dir);
  assert.ok(lock.token);
  await rm(dir, { recursive: true, force: true });
});
