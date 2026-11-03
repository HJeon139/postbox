// An asset write succeeds only for a conversation that still exists (#516 S3): its room is the conversation’s root
// thread, so a write to a room with no thread, or one being deleted, is refused as not found, and leaves no room index
// and no kept file behind.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { Store } from '../server/store.mjs';

function room(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-assetroom-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(null);
  store.emit('thread', { id: 'c1', members: [] });
  const blobs = assetBlobs(dir);
  const write = (req) => writeAsset(store, blobs, { kind: 'write', room: 'c1', type: 'text/markdown', author: 'dev', ...req });
  return { store, write };
}

/** The hashes some room’s index keeps, as the load’s sweep reads them (server/asset-orphans.mjs). */
const kept = (state) => Object.values(state.assetRooms ?? {}).flatMap((index) => Object.keys(index.files));

test('a write to a room ID that was never created is refused as not found', async (t) => {
  const { store, write } = room(t);
  const r = await write({ room: 'nope', name: 'a.md', bytes: Buffer.from('one') });
  assert.deepEqual([r.ok, r.code], [false, 'not-found']);
  assert.equal(store.state.assetRooms?.nope, undefined);
});

test('a write after its conversation is deleted is refused, leaving no room index and no kept file', async (t) => {
  const { store, write } = room(t);
  assert.equal((await write({ name: 'a.md', bytes: Buffer.from('one') })).ok, true);
  // What deleting a conversation emits (server/thread-erase.mjs): its assets erased, then the thread removed.
  store.emit('asset.erase', { room: 'c1', at: 5 });
  store.emit('remove', { kind: 'thread', id: 'c1' });
  const late = await write({ name: 'late.md', bytes: Buffer.from('two') });
  assert.deepEqual([late.ok, late.code], [false, 'not-found']);
  assert.equal(store.state.assetRooms.c1, undefined, 'no index for a room that’s gone');
  assert.deepEqual(Object.keys(store.state.assets), []);
  assert.deepEqual(kept(store.state), [], 'no version keeps the second write’s file');
});

test('a write while its conversation is being deleted is refused as deleting, saying to write again after Undo; after Undo it’s taken', async (t) => {
  const { store, write } = room(t);
  store.emit('thread', { id: 'c1', members: [], deleting: Date.now() + 10_000 });
  const during = await write({ name: 'a.md', bytes: Buffer.from('one') });
  assert.deepEqual([during.ok, during.code], [false, 'deleting']);
  assert.match(during.message, /being deleted.*Undo.*write again/);
  assert.deepEqual(Object.keys(store.state.assets), [], 'nothing committed');
  assert.equal(store.state.assetRooms?.c1, undefined, 'no index record');
  store.emit('thread', { id: 'c1', members: [], deleting: null });
  assert.equal((await write({ name: 'a.md', bytes: Buffer.from('one') })).ok, true, 'Undo sets deleting to null');
});
