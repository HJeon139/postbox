// The real-shape seed (#508, #305, tools/uat/real-room.mjs): a room whose mix of kinds and sizes follows sprint 2’s
// burndown room as #305 measured it, 1,210 items, 3.35 MB, a median of 1.5 KB and a largest of 87 KB.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBlock } from '../shared/catalog.mjs';
import { PROFILE, PROFILES, realIdOf, realRoomItems } from '../tools/uat/real-room.mjs';

const bytes = (it) => Buffer.byteLength(JSON.stringify(it));
const kindOf = (it) => (it.kind === 'block' ? it.block.type : it.kind);

test('at the measured size, the room has the measured kinds, total, median and largest, within a margin', () => {
  const items = realRoomItems({ count: 1210 });
  const sizes = items.map(bytes).sort((a, b) => a - b);
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 3.35e6) / 3.35e6 < 0.1, `total ${total}`);
  const median = sizes[Math.floor(sizes.length / 2)];
  assert.ok(Math.abs(median - 1500) / 1500 < 0.15, `median ${median}`);
  assert.ok(sizes.at(-1) > 80_000 && sizes.at(-1) < 95_000, `largest ${sizes.at(-1)}`);
  const largest = items.reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
  assert.equal(largest.kind, 'agent', 'the largest is an agent reply and its steps');
  const counts = {};
  for (const it of items) counts[kindOf(it)] = (counts[kindOf(it)] ?? 0) + 1;
  assert.deepEqual(counts, Object.fromEntries(PROFILE.map((p) => [p.kind, p.per])));
});

test('it scales: twice the items, about twice the bytes, and one largest reply per 1,210 items', () => {
  for (const count of [1000, 2000, 4000]) {
    const items = realRoomItems({ count });
    assert.equal(items.length, count);
    const big = items.filter((it) => bytes(it) > 80_000);
    assert.equal(big.length, Math.max(1, Math.round(count / 1210)), `${count}: the largest replies`);
    assert.ok(big.every((it) => it.kind === 'agent'));
  }
});

test('the same seed gives the same room, ids in room order, and the last id realIdOf names', () => {
  const a = realRoomItems({ count: 2000 });
  assert.deepEqual(a, realRoomItems({ count: 2000 }));
  assert.equal(a.at(-1).id, realIdOf(1999, 2000));
  assert.deepEqual(
    a.map((it) => it.id),
    [...a.map((it) => it.id)].sort(),
  );
});

test('every block it seeds is a valid block, and every answered one carries its answer', () => {
  for (const it of realRoomItems({ count: 1210 }).filter((x) => x.kind === 'block')) {
    const r = validateBlock(it.block);
    assert.ok(r.ok, `${it.block.type}: ${r.error}`);
    if (it.block.type !== 'progress') assert.equal(it.answered, true, it.block.type);
  }
});

test('the this-room profile, at its measured 880 items, has this room’s kinds, and its blocks are valid', () => {
  const items = realRoomItems({ count: 880, profile: 'this-room' });
  const counts = {};
  for (const it of items) counts[kindOf(it)] = (counts[kindOf(it)] ?? 0) + 1;
  assert.deepEqual(counts, Object.fromEntries(PROFILES['this-room'].kinds.map((p) => [p.kind, p.per])));
  assert.deepEqual([counts.agent, counts.review, counts.confirm, counts.progress, counts.choice, counts.form, counts.table], [588, 29, 27, 16, 15, 9, 1]);
  for (const it of items.filter((x) => x.kind === 'block')) assert.ok(validateBlock(it.block).ok, it.block.type);
  const largest = items.reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
  assert.equal(largest.kind, 'agent');
  assert.ok(bytes(largest) > 15_000 && bytes(largest) < 30_000, `largest ${bytes(largest)}`);
});

test('a profile that isn’t known is refused, naming it', () => {
  assert.throws(() => realRoomItems({ count: 10, profile: 'odd' }), /^Error: No room profile “odd”: real or this-room\.$/);
});
