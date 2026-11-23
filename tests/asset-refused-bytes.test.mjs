// #706: a write the asset commit refuses removes the bytes it put, so an agent that keeps retrying a stale base or a
// taken name doesn’t grow the disk, while a file a version keeps stays. Row F3 of the failure table is in
// tests/asset-failures.test.mjs; these are the retries and the races around it.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { openDataFolder } from '../server/data-folder.mjs';
import { tempDir } from './temp-dirs.mjs';

const text = (s) => Buffer.from(s, 'utf8');
const req = (over) => ({ kind: 'write', room: 'c1', type: 'text/markdown', author: 'dev', ...over });

/** A data folder of its own with conversation c1, opened as Postbox’s start opens it, and closed after the test. */
async function folder(t) {
  const dir = tempDir('pb-asset706-');
  const { store } = await openDataFolder(dir);
  t.after(() => store.close().catch(() => {}));
  store.emit('thread', { id: 'c1', members: [] });
  const files = () => {
    const root = join(dir, 'assets');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((f) => readdirSync(join(root, f)).map((n) => f + n));
  };
  return { store, blobs: assetBlobs(dir), files };
}

/** Asset a.md at version 2, by dev then critic, so a write from base 1 is stale. */
async function twoVersions(f) {
  const a = await writeAsset(f.store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  await writeAsset(f.store, f.blobs, req({ id: a.id, base: 1, bytes: text('two'), author: 'critic' }));
  return a;
}

test('#706: an agent retrying a stale base, or a taken name, doesn’t grow the disk', async (t) => {
  const f = await folder(t);
  const { store } = f;
  const a = await twoVersions(f);
  for (let i = 0; i < 5; i++) {
    const stale = await writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text(`try ${i}`) }));
    const taken = await writeAsset(store, f.blobs, req({ name: 'A.md', bytes: text(`new ${i}`) }));
    assert.deepEqual([stale.code, taken.code], ['stale', 'name-taken']);
  }
  assert.equal(f.files().length, 2, 'ten refused writes left no file');
  assert.deepEqual([f.blobs.held.size, f.blobs.kept.size], [0, 0], 'every write settled what it put');
});

test('#706: a refused write of bytes a version already keeps leaves that version’s file', async (t) => {
  const f = await folder(t);
  const { store } = f;
  const a = await twoVersions(f);
  const stale = await writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('one') }));
  assert.equal(stale.code, 'stale');
  assert.equal(f.files().length, 2);
  assert.equal((await f.blobs.get(store.state.assets[a.id].versions[0].sha256)).toString(), 'one');
});

test('#706: of two writes of the same bytes at once, the refused one leaves the file the other committed', async (t) => {
  const f = await folder(t);
  const { store } = f;
  const a = await writeAsset(store, f.blobs, req({ name: 'a.md', bytes: text('one') }));
  const [x, y] = await Promise.all([
    writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('same'), author: 'critic' })),
    writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('same') })),
  ]);
  // Either may win; the other is told it’s stale.
  assert.deepEqual([x.code ?? 'ok', y.code ?? 'ok'].sort(), ['ok', 'stale']);
  assert.equal((await f.blobs.get(store.state.assets[a.id].versions[1].sha256)).toString(), 'same');
  assert.deepEqual([f.blobs.held.size, f.blobs.kept.size], [0, 0]);
});

test('#706: a refused write that replaced a damaged file a version names leaves the whole file', async (t) => {
  const f = await folder(t);
  const { store } = f;
  const a = await twoVersions(f);
  const sha = store.state.assets[a.id].versions[0].sha256;
  // As a cut-off write of an older build left it: short, under the hash a version names.
  writeFileSync(f.blobs.pathOf(sha), 'o');
  const stale = await writeAsset(store, f.blobs, req({ id: a.id, base: 1, bytes: text('one') }));
  assert.equal(stale.code, 'stale');
  assert.equal((await f.blobs.get(sha)).toString(), 'one', 'the put made it whole, and the refusal didn’t remove it');
});
