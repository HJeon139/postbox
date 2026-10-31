// 1b at the store (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, revision 4): the status the
// page and the runtime read; Retry as a reload, one at a time, refusing while a write is still in flight; what install
// resets and what a held reference sees; a torn tail trimmed before the new writer appends; a failed snapshot that warns
// and backs off instead of closing; the last durable seq the page marks unsaved changes against.
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { disk, handleWith } from './store-jsonl-fixture.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'pb-retry-'));
const thread = (id) => ({ type: 'thread', data: { id, members: [] } });
const eio = (what) => Object.assign(new Error(what), { code: 'EIO' });

/** A disk whose event-log handles answer to `faults`: { sync?, write? } are called before the real operation. */
function logDisk(faults) {
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

test('the status says writable, the cause, what was lost, a warning, whether a Retry runs, and the last durable seq', async () => {
  const dir = await tmp();
  const s = await new Store(dir).load();
  assert.deepEqual(s.status, { writable: true, cause: null, lost: null, warning: null, retrying: false, savedThrough: 0 });
  s.emit('thread', { id: 't1', members: [] });
  assert.equal(s.status.savedThrough, 0, 'an emit is applied before it is on disk');
  await s.flush();
  assert.equal(s.status.savedThrough, 1, 'flush makes it durable');
  await s.commit([thread('t2')], { opId: 'c' });
  assert.equal(s.status.savedThrough, 2, 'a commit is durable when it resolves');
  const heard = [];
  s.onStatus((st) => heard.push(st.writable));
  await s.close();
  await rm(dir, { recursive: true });
  assert.deepEqual(heard, [], 'a store that never fails tells its status listeners nothing');
});

test('Retry reloads: a landed line is kept, the epoch changes, listeners hear the status and resync, writes reopen', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 'before', members: [] });
  await s.flush();
  const epoch = s.epoch;
  const statuses = [];
  s.onStatus((st) => statuses.push(`${st.writable ? 'open' : 'closed'}${st.retrying ? ' retrying' : ''}`));
  faults.sync = () => Promise.reject(eio('disk sync refused')); // the line lands, the sync reports failure
  await assert.rejects(s.commit([thread('landed')], { opId: 'landed' }), /EIO/);
  assert.equal(s.writable, false);
  assert.equal(s.state.threads.landed, undefined, 'nothing of the rejected commit is public');
  faults.sync = null;
  await s.reload();
  assert.equal(s.writable, true);
  assert.notEqual(s.epoch, epoch, 'a new history');
  assert.ok(s.state.threads.landed, 'the landed line is in the recovered state');
  assert.ok(s.state.threads.before);
  assert.deepEqual(await s.commit([thread('landed')], { opId: 'landed' }), { seq: 2, duplicate: true });
  assert.deepEqual(statuses, ['closed', 'closed retrying', 'open']);
  await s.close();
  await rm(dir, { recursive: true });
});

test('a second Retry while one runs joins it: one install, one epoch, the same result to both', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(s.commit([thread('x')], { opId: 'x' }), /EIO/);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  faults.sync = () => gate; // the barrier’s sync waits
  const first = s.reload();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.status.retrying, true);
  const second = s.reload();
  assert.equal(second, first, 'the second joins the first');
  faults.sync = null;
  release();
  await Promise.all([first, second]);
  assert.equal(s.status.retrying, false);
  assert.equal(s.writable, true);
  await s.close();
  await rm(dir, { recursive: true });
});

test('a write still in flight on the old descriptor past the bound makes Retry refuse and stay closed (I3c)', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults), retryBoundMs: 50 }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  let finish;
  const stuck = new Promise((r) => {
    finish = r;
  });
  faults.write = async (handle, ...args) => {
    faults.write = null; // only the first write hangs
    await stuck;
    return handle.write(...args);
  };
  const hanging = s.commit([thread('hung')], { opId: 'hung' });
  await new Promise((r) => setTimeout(r, 10));
  // The failure of another path closes the store while the write hangs.
  s.fail(eio('disk sync refused'));
  assert.equal(s.writable, false);
  await assert.rejects(s.reload(), /disk isn’t answering.*restart Postbox/);
  assert.equal(s.writable, false, 'still closed');
  assert.ok(s.state.threads.t1, 'the old view is readable');
  finish();
  await hanging.catch(() => {});
  await s.close();
  await rm(dir, { recursive: true });
});

test('a torn tail left by the failed write is trimmed by Retry before the new writer appends, so the next load starts', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  faults.write = async (handle, buf, off, len) => {
    faults.write = null;
    await handle.write(buf, off, Math.floor(len / 2)); // half the line lands
    throw eio('write failed mid-line');
  };
  await assert.rejects(s.commit([thread('torn-away')], { opId: 'torn' }), /EIO/);
  await s.reload();
  await s.commit([thread('after')], { opId: 'after' });
  await s.close();
  const b = await new Store(dir).load();
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['after', 't1']);
  await b.close();
  await rm(dir, { recursive: true });
});

test('install keeps store.state’s identity, a held sub-object goes stale, and the backlog, ops and counters reset (I3a)', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  const stateRef = s.state;
  const threadsRef = s.state.threads;
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  const failing = s.commit([thread('x')], { opId: 'x' });
  s.emit('thread', { id: 'held', members: [] }); // held, then released onto memory at the failure: memory-only
  await assert.rejects(failing, /EIO/);
  assert.ok(s.state.threads.held);
  faults.sync = null;
  await s.reload();
  assert.equal(s.state, stateRef, 'the state object is the same one');
  assert.equal(s.state.threads.held, undefined, 'the memory-only emit is gone');
  assert.ok(threadsRef.held, 'a sub-object held across the install is stale');
  assert.equal(s.since(0), null, 'the backlog is reset: a page must reload the state, which the epoch tells it');
  assert.equal(s.ahead, 0);
  assert.equal(s.held, 0);
  assert.equal(s.waitingCommits, 0);
  await s.close();
  await rm(dir, { recursive: true });
});

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

test('I8: a commit made by a reload listener runs after the install and lands in the new history, once', async () => {
  const dir = await tmp();
  const faults = {};
  const s = await new Store(dir, { io: logDisk(faults) }).load();
  s.emit('thread', { id: 't1', members: [] });
  await s.flush();
  faults.sync = () => Promise.reject(eio('disk sync refused'));
  await assert.rejects(s.commit([thread('x')], { opId: 'x' }), /EIO/);
  faults.sync = null;
  let reconciled;
  s.onReload(() => {
    // Reconciliation that writes: through commit, after the install, as a stand-in for A1’s records going back to waiting.
    reconciled = s.commit([thread('reconciled')], { opId: 'reconcile' });
  });
  await s.reload();
  // The failed commit’s line landed before its sync failed, so the reload recovered it as seq 2 (I7); the listener’s
  // commit comes after the install, as seq 3.
  assert.deepEqual(await reconciled, { seq: 3, duplicate: false });
  assert.ok(s.state.threads.reconciled);
  await s.close();
  const b = await new Store(dir).load();
  assert.deepEqual(Object.keys(b.state.threads).sort(), ['reconciled', 't1', 'x']);
  await b.close();
  await rm(dir, { recursive: true });
});
