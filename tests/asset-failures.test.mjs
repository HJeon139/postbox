// The asset store’s failure table (#516 S3, design-516-s3.md, “Failure table”), one test per row, on a store with a
// data folder; F1 is in tests/assets.test.mjs. A reopen goes through openDataFolder, as Postbox’s start does, so the
// asset folder’s pass at load (server/asset-orphans.mjs) runs where it runs in production.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { tempDir } from './temp-dirs.mjs';

const text = (s) => Buffer.from(s, 'utf8');
const req = (over) => ({ kind: 'write', room: 'c1', type: 'text/markdown', author: 'dev', ...over });

/** Conversations c1 and c2, the rooms these tests write to, once per folder: a write needs its room’s conversation. */
function withRooms(store) {
  for (const id of ['c1', 'c2']) if (!store.state.threads[id]) store.emit('thread', { id, members: [] });
  return store;
}

/**
 * A data folder of its own, its stores closed after the test, and removed when the file ends, even where a test left a
 * folder in it read-only (#797).
 */
async function folder(t) {
  const dir = tempDir('pb-assetf-');
  const open = [];
  t.after(async () => {
    for (const s of open) await s.close().catch(() => {});
  });
  const warned = [];
  /** Opens the folder as Postbox’s start does; the last store opened is closed before the next opens. */
  const reopen = async () => {
    await open.at(-1)?.close();
    const { store } = await openDataFolder(dir).catch((e) => Promise.reject(e));
    open.push(store);
    return withRooms(store);
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
  const store = withRooms(await new Store(f.dir, { io: logDisk(faults) }).load());
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

test('F7: a Retry reloads the store while the commit is in flight: the write is not confirmed', async (t) => {
  const reloaded = Object.assign(new Error('The store was reset while this write was in flight.'), { code: 'ERELOADED' });
  // The store’s side of this is its own tests’; here, what the asset write makes of that rejection.
  const store = /** @type {any} */ ({ commit: async () => Promise.reject(reloaded) });
  const dir = await mkdtemp(join(tmpdir(), 'pb-assetf7-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blobs = assetBlobs(dir);
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
  const rt = { s: store.state, store, stopKeptJobs: async () => {}, stopMirrorFor: () => {} };
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

test('F12: an older Postbox loses the asset versions logged since its last snapshot; their files are kept, counted, never deleted', async (t) => {
  const f = await folder(t);
  let store = await f.reopen();
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  await store.snapshot(); // version 1 is in the snapshot
  const b = await writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('two') }));
  await store.close();
  f.open.length = 0;
  // What an older Postbox leaves: its reducer has no asset events, so apply() throws on each one logged since the
  // snapshot (shared/state.mjs’s apply), it keeps them as rejected, and its next snapshot drops the segments that held
  // them (server/store-snapshot.mjs). The snapshot’s keys it doesn’t know, assets among them, it keeps as they were.
  // Here the log loses those lines, as that snapshot would.
  for (const seg of readdirSync(f.dir).filter((n) => /^events-/.test(n))) {
    const lines = readFileSync(join(f.dir, seg), 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((l) => ![JSON.parse(l)].flat().some((e) => String(e.type).startsWith('asset')));
    writeFileSync(join(f.dir, seg), kept.map((l) => `${l}\n`).join(''));
  }
  store = await f.reopen();
  assert.deepEqual(
    store.state.assets[a.id].versions.map((x) => x.v),
    [1],
    'version 1, from the snapshot, is kept; version 2 is lost',
  );
  assert.deepEqual(f.files().sort(), [a.version.sha256, b.version.sha256].sort(), 'both files stay: nothing released version 2’s');
  const warned = [];
  const swept = await sweepAssets(store, f.blobs, { warn: (l) => warned.push(l) });
  assert.deepEqual([swept.deleted, swept.unclaimed.count, swept.unclaimed.bytes], [[], 1, 3]);
  assert.match(warned.join('\n'), /1 file \(3 bytes\) .* no asset names.*They’re kept/);
});

test('F8: a released file that can’t be deleted stays released, so the next load tries again, and isn’t counted as unclaimed', async (t) => {
  const f = await folder(t);
  const store = await f.reopen();
  store.emit('thread', { id: 'c1', members: [] });
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  store.emit('asset.erase', { room: 'c1', at: 5 });
  await store.flush();
  const sha = a.version.sha256;
  const folderOf = join(f.dir, 'assets', sha.slice(0, 2));
  // Writable again even if the sweep throws (#797).
  t.after(() => existsSync(folderOf) && chmodSync(folderOf, 0o700));
  chmodSync(folderOf, 0o500); // its folder can’t be written, so unlink fails with EACCES
  const warned = [];
  const swept = await sweepAssets(store, f.blobs, { warn: (l) => warned.push(l) });
  chmodSync(folderOf, 0o700); // so the next pass can delete it
  assert.deepEqual(swept.deleted, []);
  assert.ok(store.state.assetReleases[sha], 'still released');
  assert.ok(f.files().includes(sha));
  assert.equal(swept.unclaimed.count, 0, 'a released file isn’t unclaimed');
  assert.match(warned.join('\n'), /couldn’t delete a released asset file.*tries again at the next start/);
  const again = await sweepAssets(store, f.blobs, { warn: () => {} });
  assert.deepEqual(again.deleted, [sha], 'the next pass deletes it');
});

test('F8: the hashes are dropped only after their files are gone, so a load that stops between the two loses nothing', async (t) => {
  const f = await folder(t);
  let store = await f.reopen();
  store.emit('thread', { id: 'c1', members: [] });
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  store.emit('asset.erase', { room: 'c1', at: 5 });
  await store.flush();
  const sha = a.version.sha256;
  // The commit that drops the hash fails, as if Postbox stopped right after the delete.
  const stopped = { state: store.state, commit: async () => Promise.reject(new Error('stopped')) };
  const warned = [];
  await sweepAssets(/** @type {any} */ (stopped), f.blobs, { warn: (l) => warned.push(l) });
  assert.ok(!f.files().includes(sha), 'the file is gone');
  assert.ok(store.state.assetReleases[sha], 'its hash is still released');
  assert.match(warned.join('\n'), /deleted released asset files but couldn’t record it/);
  store = await f.reopen();
  assert.deepEqual(Object.keys(store.state.assetReleases), [], 'the next load drops it');
  assert.deepEqual(f.files(), []);
});
