// close() meeting an operation already under way (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants;
// gpt’s and critic’s findings on 1b): a Retry held at its candidate load, at its barrier or in its reconciliation, and a
// snapshot in flight. close() waits for each, so the lock is released only once nothing can install, reopen or prune.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { disk } from './store-jsonl-fixture.mjs';
import { eio, logDisk, thread, tmp } from './store-retry-fixture.mjs';

test('close() during a Retry held at its barrier waits for it, so the lock is released only once nothing can install or reopen', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults) }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.commit([thread('x')], { opId: 'x' }), /EIO/);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  faults.sync = () => gate; // Retry’s fresh-descriptor barrier is held
  const retry = a.reload();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.status.retrying, true);
  let closed = false;
  const closing = a.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closed, false, 'close() waits for the Retry under way');
  await assert.rejects(new Store(dir).load(), /Another Postbox store/, 'the lock is still A’s meanwhile');
  faults.sync = null;
  release();
  await retry.catch(() => {});
  await closing;
  assert.equal(a.closed, true);
  assert.equal(a.writable, false);
  assert.equal(a.fh, null, 'no descriptor survives the close');
  await assert.rejects(a.reload(), /closed/, 'and no later Retry reopens it');
  const b = await new Store(dir).load(); // the folder is B’s now
  await b.commit([thread('b1')], { opId: 'b1' });
  assert.equal(a.emit('thread', { id: 'late', members: [] }).seq, undefined, 'A’s late emit is applied nowhere');
  await b.close();
  const c = await new Store(dir).load();
  assert.deepEqual(Object.keys(c.state.threads).sort(), ['b1', 't1', 'x'], 'B’s line and the landed one, nothing from A after the close');
  await c.close();
  await rm(dir, { recursive: true });
});

/**
 * A store after close() met a Retry under way: close() waited, so the Retry ran to its end first (it may well have
 * reopened, which is the designed order), and then the close retired the store: no descriptor, nothing heard “open”
 * after the close, and no later Retry runs.
 */
async function endsClosed(a, heard) {
  assert.equal(a.closed, true);
  assert.equal(a.writable, false);
  assert.equal(a.fh, null, 'no descriptor survives the close');
  assert.ok(!heard.some((h) => h.startsWith('after-close:open')), `nothing opened after the close: ${heard.join()}`);
  await assert.rejects(a.reload(), /closed/);
}

/** Status words, marked when they came after the store had closed. */
const listen = (a, heard) => a.onStatus((st) => heard.push(`${a.closed ? 'after-close:' : ''}${st.writable ? 'open' : 'closed'}`));

test('close() during a Retry held at its candidate load waits, and the Retry ends without installing', async () => {
  const dir = await tmp();
  const faults = {};
  let holdRead = null;
  const io = {
    ...logDisk(faults),
    readFile: async (...args) => {
      if (holdRead && String(args[0]).includes('events-')) await holdRead;
      return realFs.readFile(...args);
    },
  };
  const a = await new Store(dir, { io }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.commit([thread('x')], { opId: 'x' }), /EIO/);
  faults.sync = null;
  const heard = [];
  listen(a, heard);
  let release;
  holdRead = new Promise((r) => {
    release = r;
  });
  const retry = a.reload();
  await new Promise((r) => setTimeout(r, 20));
  let closed = false;
  const closing = a.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, false, 'close() waits');
  release();
  await retry.catch(() => {});
  await closing;
  await endsClosed(a, heard);
  const b = await new Store(dir).load();
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['t1', 'x']);
  await b.close();
  await rm(dir, { recursive: true });
});

test('close() during a Retry held in reconciliation waits, and the Retry ends without reopening', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults) }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.commit([thread('x')], { opId: 'x' }), /EIO/);
  faults.sync = null;
  const heard = [];
  listen(a, heard);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let ran;
  const listenerRan = new Promise((r) => {
    ran = r;
  });
  a.onReload(() => {
    faults.sync = () => gate; // the reconciling commit’s sync is held
    const p = a.reconcile([thread('reconciled')], { opId: 'reconcile' });
    ran();
    return p;
  });
  const retry = a.reload();
  await listenerRan;
  let closed = false;
  const closing = a.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, false, 'close() waits for the reconciliation');
  faults.sync = null;
  release();
  await retry.catch(() => {});
  await closing;
  await endsClosed(a, heard);
  const b = await new Store(dir).load();
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['reconciled', 't1', 'x'], 'the reconciled line landed before the close, nothing after');
  await b.close();
  await rm(dir, { recursive: true });
});

test('close() during a snapshot in flight: the snapshot is abandoned, nothing pruned or renamed, and the next store loads the log whole', async () => {
  const dir = await tmp();
  let hold = null;
  const io = disk({
    async open(path, flags, mode) {
      if (hold && String(path).endsWith('.tmp')) await hold;
      return realFs.open(path, flags, mode);
    },
  });
  const a = await new Store(dir, { io }).load();
  for (let i = 0; i < 3; i++) a.emit('thread', { id: `t${i}`, members: [] });
  await a.flush();
  let release;
  hold = new Promise((r) => {
    release = r;
  });
  const snap = a.snapshot();
  await new Promise((r) => setTimeout(r, 20));
  let closed = false;
  const closing = a.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, false, 'close() waits for the snapshot pass to end');
  release();
  await assert.rejects(snap, /closed while it was written/, 'the snapshot resumed into a closing store and abandoned itself');
  await closing;
  const names = (await realFs.readdir(dir)).sort();
  assert.ok(!names.includes('snapshot.json') && !names.some((n) => n.endsWith('.tmp')), `nothing renamed or left behind: ${names.join()}`);
  assert.ok(names.includes('events-1.jsonl'), 'the log was not pruned');
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 3, 'the next store loads the whole log');
  await b.close();
  await rm(dir, { recursive: true });
});

test('a Retry started right after close() begins is refused at once, and the next owner’s partial line is never trimmed (gpt’s repro)', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults) }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.commit([thread('x')], { opId: 'x' }), /EIO/);
  faults.sync = null;
  const closing = a.close();
  const retried = a.reload(); // in close()’s first gap
  // Refused at once, before close() has awaited anything: a Retry that merely failed later would already have read the
  // folder, and could have trimmed another owner’s line on the way.
  const outcome = await Promise.race([
    retried.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((r) => setTimeout(() => r('pending'), 0)),
  ]);
  assert.equal(outcome, 'rejected', 'no Retry starts once close() has begun');
  await assert.rejects(retried, /closed/);
  await closing;
  // B owns the folder and writes a commit in two halves: nothing of A may touch the file in between.
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
  const commit = b.commit([thread('b1')], { opId: 'b1' });
  await new Promise((r) => setTimeout(r, 20));
  finish();
  assert.deepEqual(await commit, { seq: 3, duplicate: false });
  await b.close();
  const c = await new Store(dir).load();
  assert.deepEqual(Object.keys(c.state.threads).sort(), ['b1', 't1', 'x'], 'the restart loads cleanly');
  await c.close();
  await rm(dir, { recursive: true });
});

test('a Retry whose barrier never resolves doesn’t hang close(): within the bound the lock is released and no descriptor stays', async () => {
  const dir = await tmp();
  const faults = {};
  const a = await new Store(dir, { io: logDisk(faults), retryBoundMs: 50 }).load();
  a.emit('thread', { id: 't1', members: [] });
  await a.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(a.commit([thread('x')], { opId: 'x' }), /EIO/);
  faults.sync = () => new Promise(() => {}); // the barrier’s fsync never answers
  a.reload().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await a.close();
  assert.ok(Date.now() - t0 < 1000, 'close() returned within the bound');
  assert.equal(a.closed, true);
  assert.equal(a.fh, null, 'no descriptor stays open');
  faults.sync = null;
  const b = await new Store(dir).load(); // the lock was released
  assert.ok(b.state.threads.t1);
  await b.close();
  await rm(dir, { recursive: true });
});
