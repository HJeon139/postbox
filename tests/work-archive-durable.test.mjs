// The archive pass on a store on disk (#305; designs/305-archive-turns.md, “One pass”, “Failure modes and crash
// points”): the file is published before the commit that names it, a replay gives the same state, a crash between the
// two archives once at the next start, and a work.patch around a held archive commit is seen or dropped, never lost
// into a half entry.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { memoryBlobs } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { heldStore, until } from './stop-reply-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';
import { archived, C, pass, room, summaries } from './work-archive-fixture.mjs';

/** A data folder with three turns of alpha’s, durable, and its blob store. */
async function onDisk() {
  const dir = tempDir('pb-archive-');
  const s = room(undefined, await new Store(dir).load());
  await s.flush();
  return { dir, s, blobs: new Blobs(join(dir, 'blobs')) };
}
const files = async (/** @type {string} */ dir) => (await readdir(join(dir, 'blobs'), { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
const lists = (/** @type {Store} */ s) => JSON.stringify({ work: s.state.work, items: s.state.items });

test('T-12: the file is published before the event that names it, a commit with opId turn.archive:<convId>:<turnId>', async () => {
  const s = room();
  const blobs = memoryBlobs();
  const seen = [];
  const store = Object.assign(Object.create(s), {
    commit: async (/** @type {any} */ fn, /** @type {any} */ o) => {
      const [ev] = fn(s.state);
      const there = await blobs.get(ev.data.sha256).then(
        () => true,
        () => false,
      );
      seen.push({ type: ev.type, opId: o.opId, there });
      return s.commit(fn, o);
    },
  });
  await pass(store, { blobs });
  assert.deepEqual(seen, [{ type: 'turn.archive', opId: `turn.archive:${C}:t1`, there: true }]);
});

test('T-2: a replay of the log gives the same state, and a second pass changes nothing', async () => {
  const { dir, s, blobs } = await onDisk();
  assert.equal(await pass(s, { blobs }), 1);
  const before = lists(s);
  await s.close();
  const again = await new Store(dir).load();
  assert.equal(lists(again), before);
  const seq = again.state.seq;
  assert.equal(await pass(again, { blobs }), 0);
  assert.equal(again.state.seq, seq, 'nothing written');
  await again.close();
});

test('T-4: a crash after the file and before the event leaves the turn hot, and the next start archives it once', async () => {
  const { dir, s, blobs } = await onDisk();
  const crash = Object.assign(new Error('killed'), { code: 'EKILLED' });
  const dying = Object.assign(Object.create(s), { commit: () => Promise.reject(crash) });
  await assert.rejects(pass(dying, { blobs }), (e) => e === crash);
  assert.equal((await files(dir)).length, 1, 'the file is out');
  assert.deepEqual(archived(s), [], 'no event');
  await s.close();
  const next = await new Store(dir).load();
  assert.equal(await pass(next, { blobs: new Blobs(join(dir, 'blobs')) }), 1);
  assert.equal((await files(dir)).length, 1, 'the same bytes, under the same name');
  await next.close();
  const after = await new Store(dir).load();
  assert.deepEqual(archived(after), ['t1']);
  await after.close();
});

test('T-12: a repeat of the commit before a snapshot is a duplicate; after one, it writes again and changes nothing', async () => {
  const { s, blobs } = await onDisk();
  let event = null;
  const store = Object.assign(Object.create(s), {
    commit: async (/** @type {any} */ fn, /** @type {any} */ o) => {
      [event] = fn(s.state);
      return s.commit(fn, o);
    },
  });
  await pass(store, { blobs });
  const opId = `turn.archive:${C}:t1`;
  assert.equal((await s.commit([event], { opId })).duplicate, true);
  await s.snapshot();
  const before = lists(s);
  assert.equal((await s.commit([event], { opId })).duplicate, false, 'the snapshot dropped the opId');
  assert.equal(lists(s), before, 'the reducer is idempotent');
  await s.close();
});

/** heldStore with three turns, and a commit in front held in its fsync, so emits from now on are held. */
async function holding() {
  const h = await heldStore();
  room(undefined, h.store);
  await h.store.flush();
  h.hold();
  const front = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  return { ...h, front };
}

test('T-13b: a work.patch queued ahead of the archive commit is seen when it is sequenced, and nothing is written', async () => {
  const { store, release, front } = await holding();
  store.emit('work.patch', { convId: C, id: 'w_t1_1', patch: { output: 'a background command finished' } });
  const run = pass(store, { chunk: 1 });
  await until(() => store.waitingCommits === 2, 'the archive commit, queued behind the held patch');
  release();
  await front;
  assert.equal(await run, 0);
  assert.deepEqual(archived(store), []);
  assert.equal(store.state.work[C].find((e) => e.id === 'w_t1_1').output, 'a background command finished');
  await store.close();
});

test('T-19: a work.patch held behind the archive commit, for an entry it removes, is dropped and resurrects nothing', async () => {
  const h = await heldStore();
  const { store } = h;
  room(undefined, store);
  store.emit('work.add', { convId: C, entry: { id: 'wf_a', kind: 'file', path: '/p/a.txt', turns: ['t1'], restored: null, at: 11 } });
  store.emit('work.add', { convId: C, entry: { id: 'wd_a', kind: 'change', fileId: 'wf_a', turnId: 't1', added: 3, deleted: 1, at: 12 } });
  await store.flush();
  h.hold();
  const run = pass(store);
  await h.atSync; // the archive commit is in its fsync
  store.emit('work.patch', { convId: C, id: 'w_t1_1', patch: { output: 'late' } });
  h.release();
  assert.equal(await run, 1);
  await store.flush();
  const list = store.state.work[C];
  assert.ok(!list.some((e) => e.id === 'w_t1_1'), 'no half entry');
  assert.deepEqual(summaries(store)[0].counts.lines, { added: 3, removed: 1 }, 'the change went with its turn');
  store.emit('work.patch', { convId: C, id: 'wf_a', patch: { restored: { at: 99 } } });
  assert.deepEqual(store.state.work[C].find((e) => e.id === 'wf_a').restored, { at: 99 }, 'a restore lands on the hot file entry');
  await store.close();
});
