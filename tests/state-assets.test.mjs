// The asset events in the reducer (#516 S3, shared/state-assets.mjs): what each applies, and that one with missing data
// throws with the state as it was (#609). tests/state-events.test.mjs’s frozen switch predates them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, emptyState } from '../shared/state.mjs';
import { ASSET_EVENTS } from '../shared/state-assets.mjs';

const sha = (c) => c.repeat(64);
const version = (v, over = {}) => ({
  v,
  sha256: sha(String(v)),
  size: 1,
  type: 'text/plain',
  isText: true,
  author: 'dev',
  at: v * 10,
  base: v - 1 || null,
  ...over,
});

function made() {
  const s = emptyState();
  apply(s, 'asset', { id: 'as_1', room: 'r1', name: 'a.md', created: 10 });
  apply(s, 'asset.version', { id: 'as_1', version: version(1), prunes: [], released: [] });
  return s;
}

test('every asset event type has a case here', () => {
  assert.deepEqual(Object.keys(ASSET_EVENTS).sort(), ['asset', 'asset.erase', 'asset.released', 'asset.version']);
});

test('asset makes an asset with no versions yet, and a rename keeps its versions and head', () => {
  const s = made();
  assert.deepEqual(s.assets.as_1, { id: 'as_1', room: 'r1', name: 'a.md', created: 10, head: 1, versions: [version(1)] });
  apply(s, 'asset', { id: 'as_1', room: 'r1', name: 'b.md', created: 10 });
  assert.equal(s.assets.as_1.name, 'b.md');
  assert.deepEqual([s.assets.as_1.head, s.assets.as_1.versions.length], [1, 1]);
});

test('asset.version appends the head, marks what it prunes with its time, and releases their hashes', () => {
  const s = made();
  apply(s, 'asset.version', { id: 'as_1', version: version(2), prunes: [1], released: [sha('1')] });
  assert.equal(s.assets.as_1.head, 2);
  assert.equal(s.assets.as_1.versions[0].pruned, 20);
  assert.equal(s.assetReleases[sha('1')], 20);
});

test('asset.erase removes the room’s assets and releases each kept hash; other rooms keep theirs', () => {
  const s = made();
  apply(s, 'asset.version', { id: 'as_1', version: version(2), prunes: [1], released: [sha('1')] });
  apply(s, 'asset', { id: 'as_2', room: 'r2', name: 'a.md', created: 10 });
  apply(s, 'asset.version', { id: 'as_2', version: version(1, { sha256: sha('3') }), prunes: [], released: [] });
  apply(s, 'asset.erase', { room: 'r1', at: 99 });
  assert.deepEqual(Object.keys(s.assets), ['as_2']);
  assert.equal(s.assetReleases[sha('2')], 99, 'the kept version released by the erase');
  assert.equal(s.assetReleases[sha('1')], 20, 'the pruned one stays released from its prune');
  assert.equal(s.assetReleases[sha('3')], undefined);
});

test('asset.released drops hashes from the releases', () => {
  const s = made();
  apply(s, 'asset.erase', { room: 'r1', at: 5 });
  apply(s, 'asset.released', { hashes: [sha('1'), sha('9')] });
  assert.deepEqual(Object.keys(s.assetReleases), []);
});

test('an asset event with missing or out-of-order data throws, and changes nothing', () => {
  for (const [type, data] of [
    ['asset', { id: 'as_9', room: 'r1' }],
    ['asset', { room: 'r1', name: 'b.md', created: 10 }],
    ['asset', { id: 'as_9', name: 'b.md', created: 10 }],
    ['asset.version', { id: 'as_none', version: version(1) }],
    ['asset.version', { id: 'as_1' }],
    // Version v is always versions[v - 1], which a write’s checks rely on: the next one is 2, never 3 or 1 again.
    ['asset.version', { id: 'as_1', version: version(3) }],
    ['asset.version', { id: 'as_1', version: version(1) }],
    ['asset.erase', { at: 1 }],
    ['asset.released', {}],
  ]) {
    const s = made();
    const before = JSON.stringify(s);
    assert.throws(() => apply(s, type, data), Error, type);
    assert.equal(JSON.stringify(s), before, `${type} left the state as it was`);
  }
});

test('a wrong-typed asset event throws before it changes anything (#702)', () => {
  const wrong = [];
  for (const [label, type, data] of [
    ['prunes: null', 'asset.version', { id: 'as_1', version: version(2), prunes: null, released: [] }],
    ['released: 5', 'asset.version', { id: 'as_1', version: version(2), prunes: [1], released: 5 }],
    ['a live asset renamed to 5', 'asset', { id: 'as_1', room: 'r1', name: 5, created: 10 }],
    ['a new asset named 5, in a new room', 'asset', { id: 'as_9', room: 'r9', name: 5, created: 10 }],
    ['a new asset with an empty name', 'asset', { id: 'as_9', room: 'r1', name: '', created: 10 }],
    // Not only the types the issue named: a guard narrowed to them (=== 'number', === null) lets these half-apply.
    ["prunes: 'x'", 'asset.version', { id: 'as_1', version: version(2), prunes: 'x', released: [] }],
    ['prunes: {}', 'asset.version', { id: 'as_1', version: version(2), prunes: {}, released: [] }],
    ['released: {}', 'asset.version', { id: 'as_1', version: version(2), prunes: [1], released: {} }],
    ["released: 'x'", 'asset.version', { id: 'as_1', version: version(2), prunes: [1], released: 'x' }],
    ['a live asset renamed to {}', 'asset', { id: 'as_1', room: 'r1', name: {}, created: 10 }],
    ["a live asset renamed to ['a']", 'asset', { id: 'as_1', room: 'r1', name: ['a'], created: 10 }],
    ['a live asset renamed to true', 'asset', { id: 'as_1', room: 'r1', name: true, created: 10 }],
    ['a new asset named {}, in a new room', 'asset', { id: 'as_9', room: 'r9', name: {}, created: 10 }],
  ]) {
    const s = made();
    const before = JSON.stringify(s);
    let threw = false;
    try {
      apply(s, type, data);
    } catch (e) {
      threw = e instanceof Error;
    }
    if (!threw) wrong.push(`${label}: applied`);
    else if (JSON.stringify(s) !== before) wrong.push(`${label}: changed the state, then threw`);
  }
  assert.deepEqual(wrong, []);
});

test('a name with quotes, <, & or NUL is an ordinary name in the reducer, kept as its own key', () => {
  // Agent text: nameProblem refuses a NUL upstream (server/assets.mjs), but the reducer neither throws on it nor escapes it.
  const s = made();
  const name = 'a"<&\u0000.md';
  apply(s, 'asset', { id: 'as_1', room: 'r1', name, created: 10 });
  assert.equal(s.assets.as_1.name, name);
  assert.deepEqual(Object.entries(s.assetRooms.r1.names), [[name, 'as_1']]);
});
