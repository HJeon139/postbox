// close() and the store’s own late work (#508’s storage design, “The data-folder lock”; the integrator’s re-review of 1a):
// close() draws its boundary before its first await, flushes what was acknowledged, waits for the writer’s pass, and only
// then releases the lock. A snapshot the writer began during the close abandons itself: nothing renamed, nothing pruned,
// so the next store’s lines survive. A commit or emit that arrives during the close’s flush is refused as closed, not
// written to a closed descriptor. Nothing the store starts can run after `closed`.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { run } from '../server/store-commit.mjs';
import { disk, logDisk } from './store-jsonl-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-close-'));
const thread = (id) => ({ type: 'thread', data: { id, members: [] } });
const held = () => {
  let release = () => {};
  const promise = new Promise((r) => {
    release = () => r(undefined);
  });
  return { promise, release };
};

test('a snapshot due during close()’s flush never lands after the lock is released: the next store’s line survives (the integrator’s repro)', async () => {
  const dir = await tmp();
  const faults = {};
  const rename = held(); // A’s snapshot rename, if one comes, is held until B has flushed, as in the integrator’s run
  const io = {
    ...logDisk(faults),
    async rename(from, to) {
      if (String(to).endsWith('snapshot.json')) await rename.promise;
      return disk().rename(from, to);
    },
  };
  const a = await new Store(dir, { io, snapshotEvery: 3 }).load();
  a.emit('thread', { id: 'a1', members: [] });
  await a.flush();
  const sync = held();
  faults.sync = () => sync.promise; // close()’s flush is held at its fsync
  const closing = a.close();
  await new Promise((r) => setTimeout(r, 10));
  // Two more emits during the close: on 4af0d1e0 they were applied, numbered and written, met the snapshot threshold,
  // and the writer’s snapshot ran on after the release.
  a.emit('thread', { id: 'a2', members: [] });
  a.emit('thread', { id: 'a3', members: [] });
  faults.sync = null;
  sync.release();
  await closing;
  assert.equal(a.closed, true);
  const b = await new Store(dir).load();
  b.emit('thread', { id: 'b1', members: [] });
  await b.flush();
  rename.release(); // on 4af0d1e0 A’s snapshot now renames over snapshot.json and removes events-1.jsonl, B’s segment
  await new Promise((r) => setTimeout(r, 200)); // time for that late snapshot, if one were coming
  await b.close();
  const c = await new Store(dir).load();
  assert.deepEqual(Object.keys(c.state.threads).sort(), ['a1', 'b1'], 'B’s line is kept; A’s emits during its close were applied nowhere');
  const names = (await readdir(dir)).filter((n) => /^events-|snapshot/.test(n));
  assert.ok(names.includes('events-1.jsonl') && !names.includes('snapshot.json'), `no late snapshot or pruning: ${names.join()}`);
  await c.close();
  await rm(dir, { recursive: true });
});

test('a commit or emit that arrives during close()’s flush is refused as closed, and nothing reaches the closed descriptor', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults) }).load();
  a.emit('thread', { id: 'a1', members: [] });
  await a.flush();
  const sync = held();
  faults.sync = () => sync.promise;
  const closing = a.close();
  await new Promise((r) => setTimeout(r, 10));
  const late = a.commit([thread('late')], { opId: 'late' });
  const ev = a.emit('thread', { id: 'dropped', members: [] });
  faults.sync = null;
  sync.release();
  await assert.rejects(late, /The store is closed/, 'said as closed, not as a failed write');
  assert.equal(ev.seq, undefined, 'the emit was applied nowhere');
  assert.equal(a.state.threads.dropped, undefined);
  await closing;
  const b = await new Store(dir).load();
  assert.deepEqual(Object.keys(b.state.threads), ['a1']);
  await b.close();
  await rm(dir, { recursive: true });
});

test('nothing the store starts runs after `closed`: emit, commit, flush, snapshot and the writer’s loop itself change no file', async () => {
  const dir = await tmp();
  const a = await new Store(dir, { snapshotEvery: 1 }).load();
  a.emit('thread', { id: 'a1', members: [] });
  await a.flush();
  await a.close();
  const before = (await readdir(dir)).sort();
  assert.equal(a.emit('thread', { id: 'e', members: [] }).seq, undefined);
  await assert.rejects(a.commit([thread('c')], { opId: 'c' }), /closed/);
  await assert.rejects(a.flush(), /closed/);
  await assert.rejects(a.snapshot(), /closed/);
  a.queue.push({ line: '{"seq":99}\n', seq: 99 }); // a job that somehow reached the queue
  await run(a, a.generation); // the loop called directly, as pump() would
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await readdir(dir)).sort(), before, 'no file was added, renamed or removed');
  assert.equal(a.fh, null, 'no descriptor was opened');
  await rm(dir, { recursive: true });
});

test('a descriptor that fails to close doesn’t leave the lock behind', async () => {
  const dir = await tmp();
  const io = disk({
    async open(path, flags, mode) {
      const handle = await disk().open(path, flags, mode);
      if (!String(path).includes('events-')) return handle;
      return new Proxy(handle, {
        get: (t, k) =>
          k === 'close' ? () => Promise.reject(Object.assign(new Error('close failed'), { code: 'EIO' })) : typeof t[k] === 'function' ? t[k].bind(t) : t[k],
      });
    },
  });
  const a = await new Store(dir, { io }).load();
  a.emit('thread', { id: 'a1', members: [] });
  await a.flush();
  await a.close();
  assert.equal(a.lock, null, 'released');
  const b = await new Store(dir).load(); // not refused
  assert.ok(b.state.threads.a1);
  await b.close();
  await rm(dir, { recursive: true });
});
