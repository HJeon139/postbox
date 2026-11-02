// The person’s retention rule (#516 S3, server/asset-retention.mjs): text keeps every version; a large binary keeps its
// last few; a version is pruned in the commit of the version that makes it prunable, and the prune releases its hash.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isTextBytes, prunable, roomBytes } from '../server/asset-retention.mjs';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { Store } from '../server/store.mjs';
import { ASSETS } from '../shared/limits.mjs';

const v = (n, over = {}) => ({ v: n, sha256: String(n).padStart(64, '0'), size: 10, isText: false, author: 'dev', at: n, base: n - 1 || null, ...over });
const big = ASSETS.largeBinaryBytes + 1;

test('text is UTF-8 that decodes whole, with no NUL; anything else is binary', () => {
  assert.equal(isTextBytes(Buffer.from('plain, é and 🙂')), true);
  assert.equal(isTextBytes(Buffer.from([])), true, 'empty is text');
  assert.equal(isTextBytes(Buffer.from([0x61, 0x00, 0x62])), false, 'a NUL byte');
  assert.equal(isTextBytes(Buffer.from([0xff, 0xfe])), false, 'not UTF-8');
  assert.equal(isTextBytes(Buffer.from([0xf0, 0x9f, 0x99])), false, 'a character cut short');
});

test('a large binary version is pruned once binaryVersionsKept newer versions exist, and not before', () => {
  const kept = ASSETS.binaryVersionsKept;
  const versions = Array.from({ length: kept + 1 }, (_, i) => v(i + 1, { size: big }));
  assert.deepEqual(prunable(versions), [1], 'version 1 has exactly that many newer');
  assert.deepEqual(prunable(versions.slice(0, kept)), [], 'one fewer newer: kept');
});

test('never pruned: the head, a text version, a small binary, a delete, a pinned or an already pruned version', () => {
  const n = ASSETS.binaryVersionsKept + 2;
  const tail = Array.from({ length: n - 1 }, (_, i) => v(i + 2, { size: big }));
  for (const [what, first] of [
    ['text', v(1, { size: big, isText: true })],
    ['small binary', v(1, { size: ASSETS.largeBinaryBytes })],
    ['delete', v(1, { sha256: null, size: 0 })],
    ['pinned', v(1, { size: big, pinned: true })],
    ['already pruned', v(1, { size: big, pruned: 5 })],
  ])
    assert.ok(!prunable([first, ...tail]).includes(1), what);
  assert.deepEqual(prunable([v(1, { size: big })]), [], 'a lone head');
  assert.deepEqual(prunable([v(1, { size: big }), v(2, { size: big })], { binaryVersionsKept: 0 }), [1], 'the head, even when no newer version is kept');
});

test('a room’s bytes count each distinct file once, without pruned versions, with a commit’s prunes and addition', () => {
  const assets = {
    a: { id: 'a', room: 'r', versions: [v(1), v(2), v(3, { pruned: 9 })] },
    b: { id: 'b', room: 'r', versions: [v(1)] },
    c: { id: 'c', room: 'other', versions: [v(4, { size: 1000 })] },
  };
  assert.equal(roomBytes(assets, 'r'), 20, 'versions 1 and 2; 1 twice counts once; 3 is pruned; c is another room');
  assert.equal(roomBytes(assets, 'r', { prunes: { id: 'a', vs: [2] } }), 10);
  assert.equal(roomBytes(assets, 'r', { added: { sha256: 'f'.repeat(64), size: 5 } }), 25);
});

test('the commit that makes a version prunable prunes it and releases its hash; text is never pruned', async () => {
  const store = new Store(null);
  const blobs = assetBlobs(mkdtempSync(join(tmpdir(), 'pb-ret-')));
  const write = (req) => writeAsset(store, blobs, { kind: 'write', room: 'r', type: 'application/octet-stream', author: 'dev', ...req });
  const bin = (i) => Buffer.concat([Buffer.from([0, i]), Buffer.alloc(big)]);
  const a = await write({ name: 'big.bin', bytes: bin(1) });
  for (let i = 2; i <= ASSETS.binaryVersionsKept; i++) await write({ id: a.id, base: i - 1, bytes: bin(i) });
  assert.ok(!store.state.assets[a.id].versions.some((x) => x.pruned), 'not yet');
  const next = ASSETS.binaryVersionsKept + 1;
  await write({ id: a.id, base: next - 1, bytes: bin(next), at: 77 });
  const first = store.state.assets[a.id].versions[0];
  assert.equal(first.pruned, 77, 'pruned in that commit, at its time');
  assert.equal(store.state.assetReleases[first.sha256], 77, 'its hash released');
  const back = await write({ kind: 'restore', id: a.id, base: next, version: 1 });
  assert.deepEqual([back.ok, back.code], [false, 'pruned'], 'a pruned version can’t be restored');
  assert.match(back.message, /pruned under the room’s retention rule/);
  const t = await write({ name: 'notes.md', bytes: Buffer.from('v1'), type: 'text/markdown' });
  for (let i = 2; i <= next + 2; i++) await write({ id: t.id, base: i - 1, bytes: Buffer.from(`v${i}`), type: 'text/markdown' });
  assert.ok(!store.state.assets[t.id].versions.some((x) => x.pruned), 'text keeps every version');
});
