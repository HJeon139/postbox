// A conversation’s assets through the one commit path (#516 S3, server/assets.mjs): names, the base check, repeats,
// renames, deletes and restores, the bounds and the budget. The failure table’s rows are in tests/asset-failures.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetBlobs, nameProblem, opProblem, planWrite, roomOf, writeAsset } from '../server/assets.mjs';
import { Store } from '../server/store.mjs';
import { ASSETS } from '../shared/limits.mjs';

const text = (s) => Buffer.from(s, 'utf8');

function room() {
  const store = new Store(null);
  const dir = mkdtempSync(join(tmpdir(), 'pb-assets-'));
  const blobs = assetBlobs(dir);
  const write = (req) => writeAsset(store, blobs, { kind: 'write', room: 'th_1', type: 'text/markdown', author: 'dev', ...req });
  return { store, dir, blobs, write, asset: (id) => store.state.assets[id] };
}

test('names: relative paths in the room, NFC, bounded, with no empty, . or .. part, backslash or control character', () => {
  for (const ok of ['plan.md', 'notes/plan.md', 'é/ü.txt', 'a'.repeat(ASSETS.nameBytes)]) assert.equal(nameProblem(ok), null, ok);
  for (const bad of [
    '',
    '/abs.md',
    'a//b',
    'a/./b',
    '../up',
    'a/..',
    'back\\slash',
    'nul\u0000',
    'tab\tname',
    'del\u007f',
    'a'.repeat(ASSETS.nameBytes + 1),
    7,
  ])
    assert.ok(nameProblem(bad), JSON.stringify(bad));
  assert.match(nameProblem('é'.repeat(200)) ?? '', /at most 255 bytes/, 'counted in UTF-8 bytes, not characters');
});

test('an op is 1 to 64 letters, digits, - and _, or none', () => {
  for (const ok of [undefined, null, 'a', 'retry-1_X', 'x'.repeat(ASSETS.opChars)]) assert.equal(opProblem(ok), null, String(ok));
  for (const bad of ['', 'x'.repeat(ASSETS.opChars + 1), 'has space', 'é', 'a/b', 12]) assert.ok(opProblem(bad), String(bad));
});

test('a room is its conversation’s root: side and topic threads share it', () => {
  const threads = { c: { id: 'c' }, t: { id: 't', parentId: 'c' }, s: { id: 's', parentId: 't' } };
  assert.equal(roomOf(threads, 'c'), 'c');
  assert.equal(roomOf(threads, 't'), 'c');
  assert.equal(roomOf(threads, 's'), 'c');
  assert.equal(roomOf({ x: { id: 'x', parentId: 'gone' } }, 'x'), 'x', 'a parent that’s gone ends the walk');
});

test('a create makes version 1 with its author, time, type and hash, and a write from the head makes the next', async () => {
  const { write, asset } = room();
  const a = await write({ name: 'notes/plan.md', bytes: text('one'), at: 10 });
  assert.equal(a.ok, true);
  assert.deepEqual(asset(a.id).versions[0], { ...a.version, v: 1, base: null, size: 3, isText: true, author: 'dev', at: 10, type: 'text/markdown' });
  const b = await write({ id: a.id, base: 1, bytes: text('two'), author: 'critic' });
  assert.equal(b.ok && b.version.v, 2);
  assert.equal(asset(a.id).head, 2);
  assert.equal(asset(a.id).versions[1].base, 1);
  assert.equal(asset(a.id).name, 'notes/plan.md');
});

test('I4: a write from a base that isn’t the head is refused, naming the newer version and its author', async () => {
  const { write, asset } = room();
  const a = await write({ name: 'x.md', bytes: text('one') });
  await write({ id: a.id, base: 1, bytes: text('two'), author: 'critic' });
  const stale = await write({ id: a.id, base: 1, bytes: text('mine') });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale');
  assert.match(stale.message, /@critic wrote version 2 .* since version 1\. Read version 2/);
  assert.equal(asset(a.id).versions.length, 2);
});

test('I5: a repeat makes no second version, by its op and author, or by the head’s base, bytes and author', async () => {
  const { write, asset } = room();
  const a = await write({ name: 'x.md', bytes: text('one'), op: 'c1' });
  const again = await write({ name: 'X.md', bytes: text('one'), op: 'c1' });
  assert.deepEqual([again.ok, again.repeat, again.id, again.version.v], [true, true, a.id, 1], 'a create repeated by name and op');
  await write({ id: a.id, base: 1, bytes: text('two'), op: 'u1' });
  await write({ id: a.id, base: 2, bytes: text('three'), author: 'critic' });
  const late = await write({ id: a.id, base: 1, bytes: text('two'), op: 'u1' });
  assert.deepEqual([late.ok, late.repeat, late.version.v], [true, true, 2], 'recognized after another agent’s write');
  const other = await write({ id: a.id, base: 1, bytes: text('two'), op: 'u1', author: 'critic' });
  assert.equal(other.code, 'stale', 'an op matches only with its author');
  const plain = await write({ id: a.id, base: 2, bytes: text('three'), author: 'critic' });
  assert.deepEqual([plain.ok, plain.repeat, plain.version.v], [true, true, 3], 'no op: the head’s base, bytes and author');
  assert.equal(asset(a.id).versions.length, 3);
});

test('I8: a name is unique in its room ignoring case, and free again in another room', async () => {
  const { write } = room();
  const a = await write({ name: 'Plan.md', bytes: text('one') });
  const taken = await write({ name: 'plan.MD', bytes: text('two'), author: 'critic' });
  assert.equal(taken.code, 'name-taken');
  assert.match(taken.message, new RegExp(`by asset ${a.id}`));
  assert.equal((await write({ name: 'plan.md', bytes: text('two'), room: 'th_2' })).ok, true);
});

test('a rename and a delete are versions; a deleted asset’s name is free, and a restore brings an older version back', async () => {
  const { write, asset } = room();
  const a = await write({ name: 'a.md', bytes: text('one') });
  const r = await write({ kind: 'rename', id: a.id, base: 1, name: 'b.md' });
  assert.deepEqual([r.ok, asset(a.id).name, r.version.sha256], [true, 'b.md', a.version.sha256], 'same bytes, new name');
  const d = await write({ kind: 'delete', id: a.id, base: 2 });
  assert.deepEqual([d.ok, d.version.sha256, d.version.size], [true, null, 0]);
  assert.equal((await write({ kind: 'delete', id: a.id, base: 3 })).code, 'deleted');
  const reuse = await write({ name: 'B.md', bytes: text('new') });
  assert.equal(reuse.ok, true, 'a deleted asset’s name can be used again');
  const blocked = await write({ kind: 'restore', id: a.id, base: 3, version: 1 });
  assert.equal(blocked.code, 'name-taken', 'bringing it back needs its name free');
  await write({ kind: 'delete', id: reuse.id, base: 1 });
  const back = await write({ kind: 'restore', id: a.id, base: 3, version: 1 });
  assert.deepEqual([back.ok, back.version.v, back.version.sha256], [true, 4, a.version.sha256]);
  assert.equal((await write({ kind: 'restore', id: a.id, base: 4, version: 3 })).code, 'no-version', 'a delete has nothing to restore');
  assert.equal((await write({ kind: 'restore', id: a.id, base: 4, version: 9 })).code, 'no-version');
});

test('an id from another room, or none for a rename, is refused as not found', async () => {
  const { write } = room();
  const a = await write({ name: 'a.md', bytes: text('one') });
  assert.equal((await write({ id: a.id, base: 1, bytes: text('two'), room: 'th_2' })).code, 'not-found');
  assert.equal((await write({ kind: 'rename', name: 'b.md' })).code, 'not-found');
  assert.equal((await write({ id: 'as_none', base: 1, bytes: text('two') })).code, 'not-found');
});

test('I6: a write that would take the room past its budget is refused, naming both; one that adds no bytes isn’t', () => {
  const big = { v: 1, sha256: 'a'.repeat(64), size: ASSETS.roomBytes - 10, isText: false, author: 'dev', at: 1, base: null };
  const state = { assets: { as_1: { id: 'as_1', room: 'r', name: 'big.bin', created: 1, head: 1, versions: [big] } } };
  const req = { kind: 'write', room: 'r', name: 'more.bin', newId: 'as_2', sha256: 'b'.repeat(64), size: 11, isText: false, author: 'dev', at: 2 };
  assert.throws(
    () => planWrite(state, req),
    (e) => e.code === 'budget' && e.message.includes(`budget of ${ASSETS.roomBytes}`),
  );
  assert.equal(planWrite(state, { ...req, size: 10 }).events.length, 2, 'exactly at the budget fits');
  assert.equal(planWrite(state, { ...req, sha256: big.sha256 }).events.length, 2, 'the same bytes again count once');
  assert.equal(planWrite(state, { ...req, room: 'other' }).events.length, 2, 'another room has its own budget');
});

test('I9: the version and room bounds refuse a write past them, naming the limit', () => {
  const versions = Array.from({ length: ASSETS.assetVersions }, (_, i) => ({
    v: i + 1,
    sha256: 'a'.repeat(64),
    size: 1,
    isText: true,
    author: 'dev',
    at: 1,
    base: i || null,
  }));
  const full = { assets: { as_1: { id: 'as_1', room: 'r', name: 'a.md', created: 1, head: ASSETS.assetVersions, versions } } };
  const update = { kind: 'write', room: 'r', id: 'as_1', base: ASSETS.assetVersions, sha256: 'b'.repeat(64), size: 1, isText: true, author: 'dev', at: 2 };
  assert.throws(
    () => planWrite(full, update),
    (e) => e.code === 'too-many' && e.message.includes(String(ASSETS.assetVersions)),
  );
  const many = Object.fromEntries(
    Array.from({ length: ASSETS.roomAssets }, (_, i) => [
      `as_${i}`,
      { id: `as_${i}`, room: 'r', name: `${i}.md`, created: 1, head: 1, versions: [versions[0]] },
    ]),
  );
  const create = { kind: 'write', room: 'r', name: 'one-more.md', newId: 'as_new', sha256: 'c'.repeat(64), size: 1, isText: true, author: 'dev', at: 2 };
  assert.throws(
    () => planWrite({ assets: many }, create),
    (e) => e.code === 'too-many' && e.message.includes(String(ASSETS.roomAssets)),
  );
});

test('F1: a bad name, op or size is refused before anything is written', async () => {
  const { write, dir, store } = room();
  for (const req of [
    { name: '../up.md' },
    { name: 'ok.md', op: 'bad op' },
    { name: 'ok.md', bytes: Buffer.alloc(ASSETS.assetBytes + 1) },
    { name: 'ok.md', bytes: null },
  ]) {
    const r = await write({ bytes: text('x'), ...req });
    assert.equal(r.ok, false, JSON.stringify(req).slice(0, 60));
    assert.equal(r.code, 'invalid');
  }
  assert.deepEqual(readdirSync(dir), [], 'no blob written');
  assert.deepEqual(Object.keys(store.state.assets), []);
});
