// The person’s retention rule (#516 S3, server/asset-retention.mjs): text keeps every version; a large binary keeps its
// last few; a version is pruned in the commit of the version that makes it prunable, and the prune releases its hash.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bytesAfter, isTextBytes, prunable } from '../server/asset-retention.mjs';
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

test('never pruned: a text version, a small binary, a delete, or one already pruned', () => {
  // Each sits where a new head would make it prunable: exactly binaryVersionsKept newer versions behind it.
  const tail = Array.from({ length: ASSETS.binaryVersionsKept }, (_, i) => v(i + 2, { size: big }));
  assert.deepEqual(prunable([v(1, { size: big }), ...tail]), [1], 'a large binary there is pruned');
  for (const [what, first] of [
    ['text', v(1, { size: big, isText: true })],
    ['small binary', v(1, { size: ASSETS.largeBinaryBytes })],
    ['delete', v(1, { sha256: null, size: 0 })],
    ['already pruned', v(1, { size: big, pruned: 5 })],
  ])
    assert.deepEqual(prunable([first, ...tail]), [], what);
});

test('the head is never pruned: a version waits for at least one newer, whatever binaryVersionsKept says', () => {
  assert.deepEqual(prunable([v(1, { size: big })]), [], 'a lone head');
  assert.deepEqual(prunable([v(1, { size: big })], { binaryVersionsKept: 0 }), [], 'a lone head, with none kept');
  assert.deepEqual(prunable([v(1, { size: big }), v(2, { size: big })], { binaryVersionsKept: 0 }), [1], 'the old head, once it isn’t');
});

test('a new head looks at one version only, the one it makes prunable: each commit pruned the one before', () => {
  const kept = ASSETS.binaryVersionsKept;
  // Version 1 is a large binary that a real store would have pruned at version kept + 1. Version 2 is small.
  const versions = [v(1, { size: big }), v(2), ...Array.from({ length: kept }, (_, i) => v(i + 3, { size: big }))];
  assert.deepEqual(prunable(versions), [], 'version 2 is the candidate, and it’s small');
});

test('a room’s bytes after a commit, from its index: a new file adds, a kept one doesn’t, a last keeper pruned frees', () => {
  const index = { bytes: 30, files: { [v(1).sha256]: { n: 2, size: 10 }, [v(2).sha256]: { n: 1, size: 20 } } };
  const fresh = { sha256: 'f'.repeat(64), size: 5 };
  assert.equal(bytesAfter(index, fresh, []), 35);
  assert.equal(bytesAfter(index, { sha256: v(1).sha256, size: 10 }, []), 30, 'a file the room keeps counts once');
  assert.equal(bytesAfter(index, { sha256: null, size: 0 }, []), 30, 'a delete adds nothing');
  assert.equal(bytesAfter(index, fresh, [v(2)]), 15, 'version 2’s file has one keeper, so the prune frees it');
  assert.equal(bytesAfter(index, fresh, [v(1)]), 35, 'version 1’s file has two keepers, so it stays');
  assert.equal(bytesAfter(index, { sha256: v(2).sha256, size: 20 }, [v(2)]), 30, 'pruned and written again in one commit: it stays');
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
