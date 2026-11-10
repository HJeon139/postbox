// A write repeated without its op is matched by the head (I5, server/assets.mjs repeatOf): the same author, from the
// same base, making the same version. Another agent’s identical write is stale, not a repeat (#703), and a rename or a
// delete retried without an op is a repeat, as a write is, where it was refused as stale naming the agent itself.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { Store } from '../server/store.mjs';

const text = (/** @type {string} */ s) => Buffer.from(s, 'utf8');

function room(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-asset-repeat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(null);
  store.emit('thread', { id: 'th_1', members: [] });
  const blobs = assetBlobs(dir);
  const write = (req) => writeAsset(store, blobs, { kind: 'write', room: 'th_1', type: 'text/markdown', author: 'dev', ...req });
  return { write, asset: (id) => store.state.assets[id] };
}

test('I5: another agent’s write of the head’s bytes from its base is refused as stale, not told it repeated (#703)', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  await write({ id: a.id, base: 1, bytes: text('two') });
  const other = await write({ id: a.id, base: 1, bytes: text('two'), author: 'critic' });
  assert.deepEqual([other.ok, other.code], [false, 'stale']);
  assert.equal(other.message, `@dev wrote version 2 of ${a.id} since version 1. Read version 2, then write again from it.`);
  assert.equal(asset(a.id).versions.length, 2, 'no version is credited to critic');
});

test('I5: another agent’s create of a taken name with the same bytes is refused as name-taken, not told it repeated (#703)', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  const other = await write({ name: 'x.md', bytes: text('one'), author: 'critic' });
  assert.deepEqual([other.ok, other.code], [false, 'name-taken']);
  assert.equal(other.message, `The name “x.md” is taken in this conversation, by asset ${a.id}. Write to it with its id, or pick another name.`);
  assert.equal(asset(a.id).versions.length, 1);
});

test('I5: the same agent’s write of the head’s bytes from an older base, or of other bytes from its base, is stale', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  await write({ id: a.id, base: 1, bytes: text('two') });
  const v3 = await write({ id: a.id, base: 2, bytes: text('two') });
  assert.deepEqual([v3.ok, v3.repeat, v3.version.v], [true, false, 3], 'the same bytes from a new base are a new version');
  assert.equal((await write({ id: a.id, base: 1, bytes: text('two') })).code, 'stale', 'the head’s bytes from an older base');
  assert.equal((await write({ id: a.id, base: 2, bytes: text('other') })).code, 'stale', 'other bytes from the head’s base');
  assert.equal(asset(a.id).versions.length, 3);
});

test('I5: a rename retried without an op is a repeat; another agent’s, or one to another name, is stale', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  const renamed = await write({ kind: 'rename', id: a.id, base: 1, name: 'y.md' });
  const again = await write({ kind: 'rename', id: a.id, base: 1, name: 'y.md' });
  assert.deepEqual([again.ok, again.repeat, again.version], [true, true, renamed.version]);
  const other = await write({ kind: 'rename', id: a.id, base: 1, name: 'y.md', author: 'critic' });
  assert.deepEqual([other.ok, other.code], [false, 'stale']);
  assert.equal(other.message, `@dev wrote version 2 of ${a.id} since version 1. Read version 2, then write again from it.`);
  assert.equal((await write({ kind: 'rename', id: a.id, base: 1, name: 'z.md' })).code, 'stale', 'another name is another rename');
  assert.deepEqual([asset(a.id).versions.length, asset(a.id).name], [2, 'y.md']);
});

test('I5: a rename that changes only the case of its author’s own last rename, from the same base, is stale, not a repeat', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'a.md', bytes: text('one') });
  const renamed = await write({ kind: 'rename', id: a.id, base: 1, name: 'b\u00e9.md' });
  const upper = await write({ kind: 'rename', id: a.id, base: 1, name: 'B\u00e9.md' });
  assert.deepEqual([upper.ok, upper.code], [false, 'stale'], 'Bé.md is another rename, not a retry of bé.md');
  assert.deepEqual([asset(a.id).versions.length, asset(a.id).name], [2, 'b\u00e9.md']);
  const decomposed = await write({ kind: 'rename', id: a.id, base: 1, name: 'be\u0301.md' });
  assert.deepEqual([decomposed.repeat, decomposed.version], [true, renamed.version], 'the same name, decomposed, is the same name, stored NFC');
});

test('I5: a rename to the name it has, from the base its author’s own write replaced, is stale, not a repeat of that write', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  await write({ id: a.id, base: 1, bytes: text('two') });
  const late = await write({ kind: 'rename', id: a.id, base: 1, name: 'x.md' });
  assert.deepEqual([late.ok, late.code], [false, 'stale'], 'the rename would have kept version 1’s bytes, not version 2’s');
  assert.equal(asset(a.id).versions.length, 2);
});

test('I5: a delete retried without an op is a repeat; another agent’s, or one after its author’s own write, is stale', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  const deleted = await write({ kind: 'delete', id: a.id, base: 1 });
  const again = await write({ kind: 'delete', id: a.id, base: 1 });
  assert.deepEqual([again.ok, again.repeat, again.version], [true, true, deleted.version]);
  const other = await write({ kind: 'delete', id: a.id, base: 1, author: 'critic' });
  assert.deepEqual([other.ok, other.code], [false, 'stale']);
  assert.equal(other.message, `@dev wrote version 2 of ${a.id} since version 1. Read version 2, then write again from it.`);
  assert.equal(asset(a.id).versions.length, 2);
  const b = await write({ name: 'b.md', bytes: text('one') });
  await write({ id: b.id, base: 1, bytes: text('two') });
  assert.equal((await write({ kind: 'delete', id: b.id, base: 1 })).code, 'stale', 'a delete isn’t a repeat of a write');
  assert.equal(asset(b.id).versions.length, 2);
});

test('I5: a restore retried without an op is a repeat; another agent’s is stale', async (t) => {
  const { write, asset } = room(t);
  const a = await write({ name: 'x.md', bytes: text('one') });
  await write({ id: a.id, base: 1, bytes: text('two') });
  const restored = await write({ kind: 'restore', id: a.id, base: 2, version: 1 });
  const again = await write({ kind: 'restore', id: a.id, base: 2, version: 1 });
  assert.deepEqual([again.ok, again.repeat, again.version], [true, true, restored.version]);
  assert.equal((await write({ kind: 'restore', id: a.id, base: 2, version: 1, author: 'critic' })).code, 'stale');
  assert.equal(asset(a.id).versions.length, 3);
});
