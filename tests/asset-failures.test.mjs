// The asset store’s failure table (#516 S3, design-516-s3.md, “Failure table”), one test per row, on a store with a
// data folder; F1 is in tests/assets.test.mjs. A reopen goes through openDataFolder, as Postbox’s start does, so the
// asset folder’s pass at load (server/asset-orphans.mjs) runs where it runs in production.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepAssets } from '../server/asset-orphans.mjs';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { Blobs } from '../server/blobs.mjs';
import { openDataFolder } from '../server/data-folder.mjs';
import { Store } from '../server/store.mjs';
import { eraseThreads } from '../server/thread-erase.mjs';
import { ASSETS } from '../shared/limits.mjs';
import { eio, logDisk } from './store-retry-fixture.mjs';

const text = (s) => Buffer.from(s, 'utf8');
const req = (over) => ({ kind: 'write', room: 'c1', type: 'text/markdown', author: 'dev', ...over });

/** A data folder of its own, removed after the test, with the stores opened on it closed first. */
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-assetf-'));
  const open = [];
  t.after(async () => {
    for (const s of open) await s.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const warned = [];
  /** Opens the folder as Postbox’s start does; the last store opened is closed before the next opens. */
  const reopen = async () => {
    await open.at(-1)?.close();
    const { store } = await openDataFolder(dir).catch((e) => Promise.reject(e));
    open.push(store);
    return store;
  };
  return { dir, blobs: assetBlobs(dir), reopen, open, warned, files: () => filesUnder(join(dir, 'assets')) };
}

/** Every file under the asset folder, by name. @param {string} root */
function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((f) => readdirSync(join(root, f)).map((n) => f + n));
}

test('F2: putting the bytes fails: nothing is published, no draft is left, and the agent is told the cause', async (t) => {
  const f = await folder(t);
  const store = await f.reopen();
  const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  const blobs = new Blobs(join(f.dir, 'assets'), { open: async () => Promise.reject(full) });
  const r = await writeAsset(store, blobs, req({ name: 'a.md', bytes: text('one') }));
  assert.deepEqual([r.ok, r.code], [false, 'failed']);
  assert.match(r.message, /no space left on device.*Nothing was published, and your copy is still yours/);
  assert.equal(r.cause, full);
  assert.deepEqual(f.files(), [], 'no draft left');
  assert.deepEqual(Object.keys(store.state.assets), []);
});

test('F3: the bytes are put, then the commit is refused: the state is unchanged and the file is kept, unclaimed', async (t) => {
  const f = await folder(t);
  const store = await f.reopen();
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  await writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('two'), author: 'critic' }));
  const stale = await writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('mine') }));
  assert.equal(stale.code, 'stale');
  assert.equal(store.state.assets[a.id].versions.length, 2);
  assert.equal(f.files().length, 3, 'the refused write’s bytes are on disk, named by nothing');
  const warned = [];
  const swept = await sweepAssets(store, f.blobs, { warn: (l) => warned.push(l) });
  assert.deepEqual([swept.deleted, swept.unclaimed.count], [[], 1]);
  assert.equal(f.files().length, 3, 'kept, not deleted');
  assert.match(warned.join('\n'), /found 1 file \(4 bytes\) in the asset folder that no asset names.*They’re kept/);
});

test('F4: Postbox stops after the bytes are put, before the commit: the next load keeps the file and counts it', async (t) => {
  const f = await folder(t);
  await f.reopen();
  await f.blobs.put(text('never committed')); // the write got this far
  const store = await f.reopen();
  assert.deepEqual(Object.keys(store.state.assets), []);
  assert.equal(f.files().length, 1, 'kept by the load');
  assert.equal((await sweepAssets(store, f.blobs, { warn: () => {} })).unclaimed.count, 1);
});

test('F5: the log’s fsync fails: the write is not confirmed, the store closes, and the next load decides', async (t) => {
  const f = await folder(t);
  const faults = {};
  const store = await new Store(f.dir, { io: logDisk(faults) }).load();
  f.open.push(store);
  faults.sync = async () => Promise.reject(eio('fsync refused'));
  const r = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  assert.deepEqual([r.ok, r.code], [false, 'unconfirmed']);
  assert.match(r.message, /couldn’t confirm the write was saved: .*fsync refused.*Don’t report it as published/);
  assert.equal(store.writable, false, 'closed to commits');
  const after = await f.reopen();
  const kept = Object.values(after.state.assets);
  // The line was written before the fsync failed, so this load finds it whole; the version names a file that’s there.
  assert.equal(kept.length, 1);
  assert.ok(f.files().includes(kept[0].versions[0].sha256), 'I2: its bytes are on disk');
});

test('F6: Postbox stops after the commit, before the tool answers: a retry with the op finds the version, past a snapshot', async (t) => {
  const f = await folder(t);
  let store = await f.reopen();
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one'), op: 'w-1' }));
  store = await f.reopen();
  await store.snapshot(); // the store’s own op ids are gone after a snapshot
  store = await f.reopen();
  assert.equal(store.ops.size, 0);
  const again = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one'), op: 'w-1' }));
  assert.deepEqual([again.ok, again.repeat, again.id, again.version.v], [true, true, a.id, 1]);
  assert.equal(store.state.assets[a.id].versions.length, 1);
});

test('F7: a Retry reloads the store while the commit is in flight: the write is not confirmed', async () => {
  const reloaded = Object.assign(new Error('The store was reset while this write was in flight.'), { code: 'ERELOADED' });
  // The store’s side of this is its own tests’; here, what the asset write makes of that rejection.
  const store = /** @type {any} */ ({ commit: async () => Promise.reject(reloaded) });
  const blobs = assetBlobs(await mkdtemp(join(tmpdir(), 'pb-assetf7-')));
  const r = await writeAsset(store, blobs, req({ name: 'a.md', bytes: text('one') }));
  assert.deepEqual([r.ok, r.code, r.cause], [false, 'unconfirmed', reloaded]);
});

test('F8: a prune commits: the hash is released, the file stays until the next load deletes it; another room’s copy is kept', async (t) => {
  const f = await folder(t);
  let store = await f.reopen();
  const big = (i) => Buffer.concat([Buffer.from([0, i]), Buffer.alloc(ASSETS.largeBinaryBytes)]);
  const shared = await writeAsset(store, f.blobs, req({ room: 'c2', name: 'same.bin', bytes: big(1), type: 'application/octet-stream' }));
  const a = await writeAsset(store, f.blobs, req({ name: 'big.bin', bytes: big(1), type: 'application/octet-stream' }));
  const b = await writeAsset(store, f.blobs, req({ name: 'other.bin', bytes: big(9), type: 'application/octet-stream' }));
  for (let i = 2; i <= ASSETS.binaryVersionsKept + 1; i++) {
    await writeAsset(store, f.blobs, req({ id: a.id, base: i - 1, bytes: big(i), type: 'application/octet-stream' }));
    await writeAsset(store, f.blobs, req({ id: b.id, base: i - 1, bytes: big(10 + i), type: 'application/octet-stream' }));
  }
  const sameHash = a.version.sha256;
  const gone = b.version.sha256;
  assert.equal(shared.version.sha256, sameHash, 'room c2 keeps the same bytes');
  assert.ok(store.state.assetReleases[sameHash] && store.state.assetReleases[gone], 'both released by their prunes');
  assert.ok(f.files().includes(gone), 'not deleted while Postbox runs');
  store = await f.reopen();
  assert.ok(!f.files().includes(gone), 'deleted at the load');
  assert.ok(f.files().includes(sameHash), 'I2: kept, since room c2’s version names it');
  assert.deepEqual(Object.keys(store.state.assetReleases), [], 'both hashes leave the releases');
});

test('F9: two agents write the same asset from one base at once: one version, and the other is told which', async (t) => {
  const f = await folder(t);
  const store = await f.reopen();
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  const [x, y] = await Promise.all([
    writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('dev’s'), author: 'dev' })),
    writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('critic’s'), author: 'critic' })),
  ]);
  assert.deepEqual([x.ok, y.ok].sort(), [false, true]);
  const lost = x.ok ? y : x;
  assert.equal(lost.code, 'stale');
  assert.match(lost.message, /wrote version 2 .* Read version 2/);
  assert.equal(store.state.assets[a.id].versions.length, 2);
});

test('F10: two agents create assets with the same name at once, in different case: one asset, the other told by which', async (t) => {
  const f = await folder(t);
  const store = await f.reopen();
  const [x, y] = await Promise.all([
    writeAsset(store, f.blobs, req({ name: 'Plan.md', bytes: text('dev’s'), author: 'dev' })),
    writeAsset(store, f.blobs, req({ name: 'plan.md', bytes: text('critic’s'), author: 'critic' })),
  ]);
  assert.deepEqual([x.ok, y.ok].sort(), [false, true]);
  const [won, lost] = x.ok ? [x, y] : [y, x];
  assert.equal(lost.code, 'name-taken');
  assert.match(lost.message, new RegExp(`by asset ${won.id}`));
  assert.equal(Object.keys(store.state.assets).length, 1);
});

test('F11: erasing a conversation erases its assets and releases their files, which the next load deletes; a topic alone erases none', async (t) => {
  const f = await folder(t);
  let store = await f.reopen();
  store.emit('thread', { id: 'c1', members: [] });
  store.emit('thread', { id: 't1', parentId: 'c1', kind: 'topic', members: [] });
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  const rt = { s: store.state, store, heldForUndo: new Map(), stopKeptJobs: async () => {}, stopMirrorFor: () => {} };
  const heard = [];
  store.subscribe((e) => heard.push(e.type));
  eraseThreads(rt, ['t1'], 'Its session was deleted.');
  assert.ok(store.state.assets[a.id], 'a topic thread is never a room');
  assert.ok(!heard.includes('asset.erase'), 'so erasing one writes no asset event');
  eraseThreads(rt, ['c1'], 'The conversation was deleted.');
  await store.flush();
  assert.deepEqual(Object.keys(store.state.assets), []);
  assert.ok(store.state.assetReleases[a.version.sha256], 'released by the erase');
  assert.ok(f.files().includes(a.version.sha256), 'still on disk while Postbox runs');
  store = await f.reopen();
  assert.deepEqual(f.files(), [], 'deleted at the load');
  assert.deepEqual(Object.keys(store.state.assetReleases), []);
});

test('F12: an older Postbox dropped the assets’ metadata: their files are kept, counted, and never deleted', async (t) => {
  const f = await folder(t);
  const store = await f.reopen();
  await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  await store.close();
  f.open.length = 0;
  // An older Postbox has no asset events: its reducer rejects them, and its next snapshot drops them (design, F12).
  // Here, a store on another folder that never had them, with this folder’s asset files.
  const older = await mkdtemp(join(tmpdir(), 'pb-assetf12-'));
  t.after(() => rm(older, { recursive: true, force: true }));
  const blank = await new Store(older).load();
  const warned = [];
  const swept = await sweepAssets(blank, f.blobs, { warn: (l) => warned.push(l) });
  await blank.close();
  assert.deepEqual([swept.deleted, swept.unclaimed.count], [[], 1]);
  assert.equal(f.files().length, 1, 'the bytes stay');
  assert.match(warned.join('\n'), /1 file .* no asset names.*They’re kept/);
});
