// An asset write succeeds only for a conversation that still exists (#516 S3): its room is the conversation’s root
// thread, so a write to a room with no thread is refused as `no-conversation`, saying it was deleted (#724), and leaves
// no room index or kept file behind.
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

/** A refusal for a conversation that’s gone says so, and points at nothing a gone conversation has (#724). */
function saysGone(r) {
  assert.deepEqual([r.ok, r.code], [false, 'no-conversation']);
  assert.match(r.message, /deleted/);
  assert.doesNotMatch(r.message, /list_assets|restore_asset/, 'no tool can help a conversation that’s gone');
}

test('a write to a room ID that was never created is refused as having no conversation', async (t) => {
  const { store, write } = room(t);
  const r = await write({ room: 'nope', name: 'a.md', bytes: Buffer.from('one') });
  saysGone(r);
  assert.equal(store.state.assetRooms?.nope, undefined);
});

test('a write after its conversation is deleted is refused, leaving no room index and no kept file', async (t) => {
  const { store, write } = room(t);
  assert.equal((await write({ name: 'a.md', bytes: Buffer.from('one') })).ok, true);
  // What deleting a conversation emits (server/thread-erase.mjs): its assets erased, then the thread removed.
  store.emit('asset.erase', { room: 'c1', at: 5 });
  store.emit('remove', { kind: 'thread', id: 'c1' });
  const late = await write({ name: 'late.md', bytes: Buffer.from('two') });
  saysGone(late);
  assert.equal(store.state.assetRooms.c1, undefined, 'no index for a room that’s gone');
  assert.deepEqual(Object.keys(store.state.assets), []);
  assert.deepEqual(kept(store.state), [], 'no version keeps the second write’s file');
});

test('a conversation erased between the bytes being stored and the commit: the write is refused, and no room is rebuilt (#723)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-assetroom-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(null);
  store.emit('thread', { id: 'c1', members: [] });
  const real = assetBlobs(dir);
  assert.equal(
    (await writeAsset(store, real, { kind: 'write', room: 'c1', type: 'text/plain', author: 'dev', name: 'a.md', bytes: Buffer.from('one') })).ok,
    true,
  );
  // The bytes are stored first, then the commit checks the room: here the conversation's erase lands in between, as
  // deleting it emits (server/thread-erase.mjs).
  const racing = {
    put: async (/** @type {Buffer} */ bytes) => {
      const r = await real.put(bytes);
      store.emit('asset.erase', { room: 'c1', at: 5 });
      store.emit('remove', { kind: 'thread', id: 'c1' });
      return r;
    },
  };
  const late = await writeAsset(store, /** @type {any} */ (racing), {
    kind: 'write',
    room: 'c1',
    type: 'text/plain',
    author: 'dev',
    name: 'b.md',
    bytes: Buffer.from('two'),
  });
  assert.deepEqual([late.ok, late.code], [false, 'no-conversation'], 'the room is checked in the commit, after the erase');
  assert.equal(store.state.assetRooms?.c1, undefined, 'no index rebuilt for the erased conversation');
  assert.deepEqual(Object.keys(store.state.assets), []);
  assert.deepEqual(kept(store.state), []);
});
