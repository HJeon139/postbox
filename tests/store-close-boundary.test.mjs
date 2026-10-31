// close()’s boundary and its bound (the 1b invariants, I3c; gpt’s and critic’s findings on 1b). The boundary is drawn
// before close()’s first await, so a Retry asked for in that gap is refused before it reads the folder, even when the
// failed store holds no descriptor and no writer runs (gpt’s second repro: a failed log open). The bound decides only
// what the caller is told: a Retry that never settles makes close() reject with the lock KEPT, since a flag can’t
// cancel I/O already handed to the disk; the process’s exit releases the lock, and the next start takes it over.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { LOCK } from '../server/store-lock.mjs';
import { disk } from './store-jsonl-fixture.mjs';
import { eio, logDisk, thread, tmp } from './store-retry-fixture.mjs';

test('a failed store with no descriptor: close() then reload() at once; the Retry reads nothing, and the next owner’s half-written line is never trimmed', async () => {
  const dir = await tmp();
  const seed = await new Store(dir).load();
  await seed.commit([thread('before')], { opId: 'before' });
  await seed.close();
  let failOpen = true;
  let closing = false;
  const readsAfterClose = [];
  const aio = disk({
    async open(path, ...args) {
      if (failOpen && /events-\d+\.jsonl$/.test(String(path))) {
        failOpen = false;
        throw eio('failed opening log');
      }
      return realFs.open(path, ...args);
    },
    async readFile(path, ...args) {
      const name = String(path).split('/').at(-1);
      if (closing && /snapshot|events/.test(name)) readsAfterClose.push(name); // the lock’s own read at release is not recovery
      return realFs.readFile(path, ...args);
    },
  });
  const a = await new Store(dir, { io: aio }).load();
  await assert.rejects(a.commit([thread('failed')], { opId: 'failed' }), /EIO/);
  await a.running; // the failed writer has settled: no descriptor, no writer, no Retry
  assert.equal(a.fh, null);
  closing = true;
  const closed = a.close();
  await assert.rejects(a.reload(), /closed/);
  await closed;
  assert.deepEqual(readsAfterClose, [], 'no recovery read happened once close() began');
  // B owns the folder and writes a commit in two halves.
  const bFaults = {};
  const b = await new Store(dir, { io: logDisk(bFaults) }).load();
  let finish;
  const half = new Promise((r) => {
    finish = r;
  });
  bFaults.write = async (handle, buf, off, len) => {
    bFaults.write = null;
    const first = await handle.write(buf, off, Math.floor(len / 2));
    await half;
    const rest = await handle.write(buf, off + first.bytesWritten, len - first.bytesWritten);
    return { bytesWritten: first.bytesWritten + rest.bytesWritten };
  };
  const commit = b.commit([thread('acknowledged-by-b')], { opId: 'b1' });
  await new Promise((r) => setTimeout(r, 20));
  finish();
  assert.deepEqual(await commit, { seq: 2, duplicate: false });
  await b.close();
  const c = await new Store(dir).load();
  assert.deepEqual(Object.keys(c.state.threads).sort(), ['acknowledged-by-b', 'before'], 'the restart loads cleanly');
  await c.close();
  await rm(dir, { recursive: true });
});

test('a Retry whose barrier never resolves: close() rejects within the bound, keeps the lock, and a second store is refused', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults), retryBoundMs: 50 }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.commit([thread('x')], { opId: 'x' }), /EIO/);
  let answer;
  faults.sync = () =>
    new Promise((r) => {
      answer = r; // the barrier’s fsync doesn’t answer until the spec says so
    });
  const retried = a.reload().catch((e) => e.code);
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await assert.rejects(a.close(), /can’t close.*isn’t answering.*Stop the process/);
  assert.ok(Date.now() - t0 < 1000, 'close() answered within the bound');
  assert.equal(a.closed, true);
  assert.equal(a.writable, false);
  assert.ok(a.lock, 'the lock is kept: I/O already handed to the disk may still land');
  assert.ok((await realFs.readdir(dir)).includes(LOCK));
  await assert.rejects(new Store(dir).load(), /Another Postbox store \(process \d+\) holds/);
  await assert.rejects(a.commit([thread('late')], { opId: 'late' }), /can’t close/, 'a late commit hears why');
  // The disk answers at last: the Retry finds the store retiring and installs nothing.
  answer();
  assert.equal(await retried, 'ECLOSED');
  assert.equal(a.writable, false);
  assert.ok(a.lock, 'still held: only the process’s exit releases it');
  await rm(dir, { recursive: true });
});

test('a plain emit then close(): the final flush syncs the log once, savedThrough reaches seq, and the lock is released', async () => {
  const dir = await tmp();
  const faults = {};
  let syncs = 0;
  faults.sync = async () => {
    syncs++;
  };
  const a = await new Store(dir, { io: logDisk(faults) }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.running; // the writer pass has drained the queue; the line is appended, not yet synced
  assert.deepEqual({ seq: a.state.seq, savedThrough: a.status.savedThrough, queue: a.queue.length }, { seq: 1, savedThrough: 0, queue: 0 });
  await a.close();
  assert.equal(syncs, 1, 'close() synced the log although the queue was empty');
  assert.equal(a.status.savedThrough, 1);
  assert.equal(a.lock, null);
  const b = await new Store(dir).load();
  assert.ok(b.state.threads.t1);
  await b.close();
  await rm(dir, { recursive: true });
});

test('the final sync fails: close() rejects with the cause and keeps the lock, since the log may not be durable', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults) }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.running;
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.close(), /can’t close: its last sync failed \(EIO\): disk sync refused.*Stop the process/);
  assert.equal(a.closed, true);
  assert.ok(a.lock, 'the lock is kept');
  assert.ok((await realFs.readdir(dir)).includes(LOCK));
  await assert.rejects(new Store(dir).load(), /Another Postbox store/);
  await rm(dir, { recursive: true });
});
