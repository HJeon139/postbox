import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deferred, disk, eventsIn, folder, handleWith, opened, waiting } from './store-jsonl-fixture.mjs';
import { recoveryDisk } from './store-jsonl-reload-fixture.mjs';

const change = (id) => [{ type: 'thread', data: { id, members: [] } }];

test('Retry keeps a landed commit private until a fresh descriptor syncs, then deduplicates it', async (t) => {
  const dir = await folder(t);
  const { io, control } = recoveryDisk();
  const store = await opened(t, dir, { io });
  assert.equal(typeof store.reload, 'function');
  const epoch = store.epoch;
  const heard = [];
  store.subscribe((event) => heard.push(event));
  control.armed = true;
  try {
    await assert.rejects(waiting(store.commit(change('once'), { opId: 'uncertain' }), 'commit rejection'), /lost sync result/);
    const bytes = await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8');
    assert.equal(eventsIn(bytes)[0].data.id, 'once', 'the rejected transaction actually landed');
    const reloaded = store.reload();
    await waiting(control.entered.promise, 'the fresh recovery descriptor to sync');
    assert.equal(store.state.threads.once, undefined);
    assert.equal(store.epoch, epoch, 'the candidate epoch is private too');
    assert.deepEqual(heard, []);
    assert.deepEqual(store.since(0), []);
    await assert.rejects(store.commit(change('once'), { opId: 'uncertain' }), /lost sync result|EIO/);
    control.release.resolve();
    await waiting(reloaded, 'Retry to finish');
    assert.ok(control.closed.has(control.failedHandle), 'the failed descriptor was closed');
    assert.ok(
      control.synced.some((id) => id !== control.failedHandle),
      'a fresh descriptor completed the barrier',
    );
    assert.notEqual(store.epoch, epoch);
    assert.ok(store.state.threads.once);
    assert.deepEqual(await store.commit(change('once'), { opId: 'uncertain' }), { seq: 1, duplicate: true });
    assert.equal(await fs.readFile(join(dir, 'events-1.jsonl'), 'utf8'), bytes);
  } finally {
    control.mode = 'normal';
    control.release.resolve();
  }
});

test('a failed recovery barrier leaves the old public view and epoch readable and writes closed', async (t) => {
  const dir = await folder(t);
  const { io, control } = recoveryDisk();
  const store = await opened(t, dir, { io });
  assert.equal(typeof store.reload, 'function');
  const before = JSON.stringify(store.state);
  const epoch = store.epoch;
  control.armed = true;
  control.mode = 'reject';
  try {
    await assert.rejects(store.commit(change('private'), { opId: 'failed-recovery' }), /lost sync result/);
    await assert.rejects(store.reload(), /recovery sync refused/);
    assert.equal(JSON.stringify(store.state), before);
    assert.equal(store.epoch, epoch);
    assert.equal(store.writable, false);
    await assert.rejects(store.commit(change('later'), { opId: 'later' }), /EIO|sync/);
    control.mode = 'normal';
    await store.reload();
    assert.ok(store.state.threads.private);
    assert.notEqual(store.epoch, epoch);
  } finally {
    control.mode = 'normal';
    control.release.resolve();
  }
});

test('reload cannot install its candidate while an old writer callback can still publish', async (t) => {
  const dir = await folder(t);
  const entered = deferred();
  const release = deferred();
  let armed = false;
  let store;
  const io = disk({
    open: async (path, ...args) => {
      const handle = await fs.open(path, ...args);
      if (!/events-\d+\.jsonl$/.test(String(path))) return handle;
      return handleWith(handle, {
        write: async (...writeArgs) => {
          const result = await handle.write(...writeArgs);
          if (armed) {
            armed = false;
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      });
    },
  });
  store = await opened(t, dir, { io });
  assert.equal(typeof store.reload, 'function');
  const epoch = store.epoch;
  const stalePublications = [];
  store.subscribe((event) => {
    if (event.seq <= 2 && store.epoch !== epoch) stalePublications.push(event);
  });
  armed = true;
  const commit = store.commit([...change('old'), { type: 'item.add', data: { threadId: 'old', item: { id: 'once', text: 'one copy' } } }], {
    opId: 'old-writer',
  });
  const outcome = commit.then(
    () => 'resolved',
    () => 'rejected',
  );
  try {
    await waiting(entered.promise, 'the old write callback');
    const reload = store.reload();
    await new Promise(setImmediate);
    release.resolve();
    await waiting(Promise.all([reload, outcome]), 'reload and the old commit to settle');
    assert.ok(store.state.threads.old, 'the completed line was recovered');
    assert.equal(store.state.items.old.length, 1, 'the old callback did not apply the recovered add twice');
    assert.deepEqual(stalePublications, [], 'the old writer never published into the recovered epoch');
    assert.equal(store.state.seq, 2);
    const recoveredEpoch = store.epoch;
    await store.commit(change('new'), { opId: 'new-writer' });
    assert.equal(store.epoch, recoveredEpoch);
    assert.deepEqual(Object.keys(store.state.threads), ['old', 'new']);
  } finally {
    release.resolve();
  }
});
