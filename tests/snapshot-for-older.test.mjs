// tools/snapshot-for-older.mjs (#1180): Postbox writes snapshot.json as lines, which a build from before #1180 can’t
// read. The tool rewrites it as one JSON value for such a build, through the store, so it holds the folder’s lock, and
// only while the state fits V8’s string limit.

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { rebuildForOlder } from '../tools/snapshot-for-older.mjs';
import { folder, opened } from './store-jsonl-fixture.mjs';

/** A folder with a small room in it, snapshotted as lines, and the store closed. */
async function room(t) {
  const dir = await folder(t);
  const store = await opened(t, dir);
  store.emit('thread', { id: 'one', members: [] });
  for (let n = 0; n < 20; n++) store.emit('item.add', { threadId: 'one', item: { id: `it_${n}`, kind: 'user', at: n, text: `${n}` } });
  await store.flush();
  await store.snapshot();
  const state = structuredClone(store.state);
  await store.close();
  return { dir, state };
}

test('#1180 the tool rewrites a line snapshot as one JSON value, which an older Postbox reads', async (t) => {
  const { dir, state } = await room(t);
  const result = await rebuildForOlder(dir);
  assert.equal(result.items, 20);
  const text = await fs.readFile(join(dir, 'snapshot.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), state, 'one JSON.parse of the file is the state, as an older build reads it');
  const again = await opened(t, dir);
  assert.deepEqual(structuredClone(again.state), state, 'this build still loads it');
});

test('#1180 the tool refuses while a Postbox holds the folder, and leaves the snapshot as it was', async (t) => {
  const { dir } = await room(t);
  const before = await fs.readFile(join(dir, 'snapshot.json'), 'utf8');
  await opened(t, dir);
  await assert.rejects(rebuildForOlder(dir), /another Postbox|lock|in use/i);
  assert.equal(await fs.readFile(join(dir, 'snapshot.json'), 'utf8'), before);
});

test('#1180 the tool refuses a state past the string limit, and leaves the snapshot as it was', async (t) => {
  const { dir } = await room(t);
  const before = await fs.readFile(join(dir, 'snapshot.json'), 'utf8');
  const real = JSON.stringify;
  JSON.stringify = /** @type {any} */ (
    (value, ...rest) => {
      if (value && typeof value === 'object' && 'seq' in value && 'items' in value) throw new RangeError('Invalid string length');
      return real(value, ...rest);
    }
  );
  t.after(() => {
    JSON.stringify = real;
  });
  await assert.rejects(rebuildForOlder(dir), /too big for one JSON value/);
  JSON.stringify = real;
  assert.equal(await fs.readFile(join(dir, 'snapshot.json'), 'utf8'), before);
});
