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
  const sha = put.sha256 ?? put;
  store.state.assetReleases[sha] = 1;
  const swept = await sweepAssets(store, blobs, { warn: () => {} });
  assert.deepEqual(swept.deleted, [sha]);
  assert.ok(!existsSync(blobs.pathOf(sha)), 'deleted');
});
