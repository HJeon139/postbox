// #691: the load pass (server/asset-orphans.mjs) deletes a released asset file once nothing keeps it, and it read what
// keeps a file from the rooms’ indexes alone (`assetRooms[room].files`). Deleting is the one step in the asset store
// that can’t be undone, so a reducer bug that let an index drift would lose bytes a version still names. The load now
// recounts what the unpruned versions keep, once, and deletes only what the index and the recount agree is released;
// where they disagree, the file stays and the log says so, with its hash and room.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { sweepAssets } from '../server/asset-orphans.mjs';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { openDataFolder } from '../server/data-folder.mjs';
import { tempDir } from './temp-dirs.mjs';

test('#691 a released hash the index lost but a version still keeps is kept, and the log names it and its room', async (t) => {
  const dir = tempDir('pb-recount-');
  const { store } = await openDataFolder(dir);
  t.after(() => store.close().catch(() => {}));
  store.emit('thread', { id: 'c1', members: [] });
  const blobs = assetBlobs(dir);
  const a = await writeAsset(store, blobs, {
    kind: 'write',
    room: 'c1',
    name: 'plan.md',
    type: 'text/markdown',
    author: 'dev',
    bytes: Buffer.from('the plan'),
  });
  assert.ok(a.ok);
  const sha = a.version.sha256;
  // The drift a reducer bug could leave: the room’s index no longer keeps the hash, and the hash is released, though
  // version 1 of plan.md, unpruned, still names it.
  delete store.state.assetRooms.c1.files[sha];
  store.state.assetReleases[sha] = 1;
  const warned = [];
  const swept = await sweepAssets(store, blobs, { warn: (line) => warned.push(line) });
  assert.deepEqual(swept.deleted, [], 'nothing deleted');
  assert.ok(existsSync(blobs.pathOf(sha)), 'the file is still on disk');
  const line = warned.find((l) => l.includes(sha));
  assert.ok(line, 'the log names the hash');
  assert.match(line, /room c1/);
  assert.match(line, /kept/);
});

test('#691 a released hash both the index and the recount agree nothing keeps is still deleted', async (t) => {
  const dir = tempDir('pb-recount-');
  const { store } = await openDataFolder(dir);
  t.after(() => store.close().catch(() => {}));
  const blobs = assetBlobs(dir);
  const put = await blobs.put(Buffer.from('released bytes'));
  const sha = put.sha256;
  store.state.assetReleases[sha] = 1;
  const swept = await sweepAssets(store, blobs, { warn: () => {} });
  assert.deepEqual(swept.deleted, [sha]);
  assert.ok(!existsSync(blobs.pathOf(sha)), 'deleted');
});

test('#691 a file a version keeps is never counted as unclaimed, though the index lost it and nothing released it', async (t) => {
  const dir = tempDir('pb-recount-');
  const { store } = await openDataFolder(dir);
  t.after(() => store.close().catch(() => {}));
  store.emit('thread', { id: 'c1', members: [] });
  const blobs = assetBlobs(dir);
  const a = await writeAsset(store, blobs, { kind: 'write', room: 'c1', name: 'notes.md', type: 'text/markdown', author: 'dev', bytes: Buffer.from('notes') });
  delete store.state.assetRooms.c1.files[a.version.sha256];
  const swept = await sweepAssets(store, blobs, { warn: () => {} });
  assert.deepEqual([swept.deleted, swept.unclaimed.count], [[], 0]);
});

test('#691 a released hash the index keeps but no version does is logged, and its file stays', async (t) => {
  const dir = tempDir('pb-recount-');
  const { store } = await openDataFolder(dir);
  t.after(() => store.close().catch(() => {}));
  store.emit('thread', { id: 'c1', members: [] });
  const blobs = assetBlobs(dir);
  const { sha256 } = await blobs.put(Buffer.from('drifted'));
  store.state.assetRooms.c1 = { count: 0, bytes: 7, ids: {}, names: {}, ops: {}, files: { [sha256]: { n: 1, size: 7 } } };
  store.state.assetReleases[sha256] = 1;
  const warned = [];
  const swept = await sweepAssets(store, blobs, { warn: (line) => warned.push(line) });
  assert.deepEqual(swept.deleted, []);
  assert.ok(existsSync(blobs.pathOf(sha256)), 'the file stays');
  assert.match(warned.find((l) => l.includes(sha256)) ?? '', /index says a version keeps it, but no version does/);
});
