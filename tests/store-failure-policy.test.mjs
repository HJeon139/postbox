// 1b’s failure policy at the store (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants I5, I7, I8 and
// critic’s findings): a failed snapshot warns and backs off instead of closing; ENOSPC and EROFS close the store with
// their cause; a reload listener’s commit lands after the install; Retry on a store that never failed is a no-op; a
// second Retry succeeds after a failed barrier.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { readdir, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { disk } from './store-jsonl-fixture.mjs';
import { eio, logDisk, thread, tmp } from './store-retry-fixture.mjs';

test('a failed snapshot warns and backs off; it does not close the store, and is not retried on every event', async () => {
  const dir = await tmp();
  let attempts = 0;
  let failing = true;
  const io = disk({
    async open(path, flags, mode) {
      if (String(path).includes('snapshot.json') && String(path).endsWith('.tmp')) {
        attempts++;
        if (failing) throw eio('snapshot refused');
      }
      return realFs.open(path, flags, mode);
    },
  });
  const s = await new Store(dir, { io, snapshotEvery: 3 }).load();
  for (let i = 0; i < 12; i++) s.emit('thread', { id: `t${i}`, members: [] });
  await s.flush();
  assert.equal(s.writable, true, 'a failed snapshot closes nothing');
  assert.match(s.status.warning ?? '', /snapshot/);
  assert.equal(attempts, 1, 'one attempt, then the backoff window');
  assert.ok(s.nextSnapshotAt > Date.now(), 'a stored next-attempt time');
  failing = false;
  s.nextSnapshotAt = 0; // the window has passed
  s.emit('thread', { id: 'again', members: [] });
  await s.flush();
  assert.equal(attempts, 2);
  assert.equal(s.status.warning, null, 'the warning clears when a snapshot succeeds');
  assert.ok((await readdir(dir)).includes('snapshot.json'));
  await s.close();
  await rm(dir, { recursive: true });
});

test('T-12: ENOSPC and EROFS on a write close the store with that cause, like EIO', async () => {
  for (const code of ['ENOSPC', 'EROFS']) {
    const dir = await tmp();
    const faults = {};
    const s = await new Store(dir, { io: logDisk(faults) }).load();
    faults.write = async () => {
      throw Object.assign(new Error(`${code} from the disk`), { code });
    };
    await assert.rejects(s.commit([thread('x')], { opId: 'x' }), new RegExp(code));
    assert.equal(s.writable, false);
    assert.equal(s.status.cause.code, code);
    await s.close();
    await rm(dir, { recursive: true });
  }
});

test('I8: a reload listener’s commit is durable before anyone hears writes reopen; a listener that fails keeps the store closed', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(s.commit([thread('x')], { opId: 'x' }), /EIO/);
  faults.sync = null;
  const heard = [];
  s.onStatus((st) => heard.push(st.writable ? 'open' : 'closed'));
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let reconciled;
  const off = s.onReload(() => {
    // Reconciliation that writes: through commit, after the install, as a stand-in for A1’s records going back to waiting.
    faults.sync = () => gate; // its fsync is held
    reconciled = s.commit([thread('reconciled')], { opId: 'reconcile' });
    return reconciled;
  });
  const retry = s.reload();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(reconciled, 'the listener ran after the install');
  assert.ok(!heard.includes('open'), `nothing heard writes reopen while the reconciliation sync is held: ${heard.join()}`);
  faults.sync = null;
  release();
  await retry;
  // The failed commit’s line landed before its sync failed, so the reload recovered it as seq 2 (I7); the listener’s
  // commit comes after the install, as seq 3.
  assert.deepEqual(await reconciled, { seq: 3, duplicate: false });
  assert.equal(heard.at(-1), 'open');
  off();
  // A listener that fails: Retry rejects, the store stays closed, naming it.
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(s.commit([thread('y')], { opId: 'y' }), /EIO/);
  faults.sync = null;
  const off2 = s.onReload(() => Promise.reject(Object.assign(new Error('records could not be rebuilt'), { code: 'ERECONCILE' })));
  await assert.rejects(s.reload(), /reconciliation after the reload failed.*records could not be rebuilt/);
  assert.equal(s.writable, false);
  assert.equal(s.status.cause.code, 'ERECONCILE');
  off2();
  await s.reload();
  assert.equal(s.writable, true);
  await s.close();
  const b = await new Store(dir).load();
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['reconciled', 't1', 'x', 'y']);
  await b.close();
  await rm(dir, { recursive: true });
});

test('Retry on a store that never failed is a no-op: memory stays ahead of the disk’s view, no second handle (critic’s finding)', async () => {
  const dir = await tmp();
  let opens = 0;
  const io = disk({
    async open(path, flags, mode) {
      if (String(path).includes('events-')) opens++;
      return realFs.open(path, flags, mode);
    },
  });
  const s = await new Store(dir, { io }).load();
  for (let i = 0; i < 50; i++) s.emit('thread', { id: `t${i}`, members: [] });
  const epoch = s.epoch;
  const retried = s.reload(); // writes are open: nothing to retry
  for (let i = 50; i < 60; i++) s.emit('thread', { id: `t${i}`, members: [] });
  await retried;
  await s.flush();
  assert.equal(s.epoch, epoch, 'no new history');
  assert.equal(Object.keys(s.state.threads).length, 60, 'memory kept every emit');
  assert.equal(s.state.seq, 60);
  assert.equal(opens, 1, 'one handle on the segment');
  await s.close();
  const b = await new Store(dir).load();
  assert.equal(b.state.seq, 60, 'the disk has them all');
  await b.close();
  await rm(dir, { recursive: true });
});

test('after a Retry whose barrier failed, a second Retry succeeds once the disk answers', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(s.commit([thread('x')], { opId: 'x' }), /EIO/);
  await assert.rejects(s.reload(), /Retry couldn’t reopen/); // the barrier’s sync fails too
  assert.equal(s.writable, false);
  assert.ok(s.state.threads.t1, 'the old view is still readable');
  faults.sync = null;
  await s.reload();
  assert.equal(s.writable, true);
  await s.commit([thread('after')], { opId: 'after' });
  await s.close();
  const b = await new Store(dir).load();
  assert.ok(b.state.threads.after);
  await b.close();
  await rm(dir, { recursive: true });
});
