// The rooms’ indexes the reducer keeps (#516 S3, shared/state-assets.mjs), which a write’s checks look up instead of
// scanning every asset. An index is only right if it always equals what the assets say, so a long run of every kind of
// write, prune and erase checks it against a count from scratch after each step, and through a snapshot’s JSON.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetBlobs, writeAsset } from '../server/assets.mjs';
import { Store } from '../server/store.mjs';
import { ASSETS } from '../shared/limits.mjs';
import { ownState } from '../shared/state.mjs';
import { nameKey, opKey } from '../shared/state-assets.mjs';

/** Each room’s index, counted from the assets alone, in the shape the reducer keeps. @param {any} state */
function recount(state) {
  const rooms = {};
  for (const a of Object.values(state.assets)) {
    const r = (rooms[a.room] ??= { count: 0, ids: {}, names: {}, files: {}, bytes: 0, ops: {} });
    r.count++;
    r.ids[a.id] = true;
    if (a.versions[a.head - 1]?.sha256) r.names[nameKey(a.name)] = a.id;
    for (const x of a.versions) {
      if (x.op) r.ops[opKey(a.id, x.author, x.op)] = x.v;
      if (!x.sha256 || x.pruned) continue;
      r.files[x.sha256] ??= { n: 0, size: x.size };
      r.files[x.sha256].n++;
    }
  }
  for (const r of Object.values(rooms)) r.bytes = Object.values(r.files).reduce((sum, f) => sum + f.size, 0);
  return rooms;
}

/** A plain copy, so null-prototype records and plain ones compare by their keys. @param {any} x */
const plain = (x) => JSON.parse(JSON.stringify(x));

/** A small seeded generator, so a failing run can be repeated. @param {number} seed */
function random(seed) {
  let s = seed;
  return (n) => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return Math.floor((s / 2 ** 31) * n); // the high bits: an LCG’s low bits repeat in short cycles
  };
}

test('the rooms’ indexes equal a count from scratch after every write, rename, delete, restore, prune and erase', async (t) => {
  const store = new Store(null);
  const blobs = assetBlobs(mkdtempSync(join(tmpdir(), 'pb-index-')));
  const pick = random(516);
  const big = (i) => Buffer.concat([Buffer.from([0, i % 251]), Buffer.alloc(ASSETS.largeBinaryBytes)]);
  const bodies = [(i) => Buffer.from(`text ${i % 5}`), big];
  const rooms = ['c1', 'c2'];
  const names = ['a.md', 'A.MD', 'b.bin', 'notes/c.md'];
  const authors = ['dev', 'critic'];
  const kinds = { write: 0, rename: 0, delete: 0, restore: 0, erase: 0, refused: 0, prune: 0 };
  store.subscribe((e) => {
    if (e.type === 'asset.version') kinds.prune += e.data.prunes.length;
  });
  for (let i = 0; i < 400; i++) {
    const room = rooms[pick(2)];
    const author = authors[pick(2)];
    const ids = Object.values(store.state.assets).filter((a) => a.room === room);
    const asset = ids.length ? ids[pick(ids.length)] : null;
    const roll = pick(20);
    let req;
    if (roll === 0) {
      store.emit('asset.erase', { room, at: i });
      kinds.erase++;
    } else if (!asset || roll < 6) req = { kind: 'write', room, name: names[pick(4)], bytes: bodies[pick(2)](pick(9)), type: 'x', author };
    else if (roll < 13)
      req = {
        kind: 'write',
        room,
        id: asset.id,
        base: asset.head,
        bytes: bodies[pick(2)](pick(9)),
        type: 'x',
        author,
        op: pick(3) ? undefined : `op-${pick(4)}`,
      };
    else if (roll < 15) req = { kind: 'rename', room, id: asset.id, base: asset.head, name: pick(2) ? `renamed-${i}.md` : names[pick(4)], author };
    else if (roll < 17) req = { kind: 'delete', room, id: asset.id, base: asset.head, author };
    else req = { kind: 'restore', room, id: asset.id, base: asset.head, version: 1 + pick(asset.versions.length), author };
    if (req) {
      const r = await writeAsset(store, blobs, { ...req, at: i });
      kinds[r.ok ? req.kind : 'refused']++;
    }
    assert.deepEqual(plain(store.state.assetRooms), recount(store.state), `step ${i}`);
  }
  // Every kind of change happened, refusals and prunes among them, so the run checked what it claims to.
  for (const [kind, n] of Object.entries(kinds)) assert.ok(n > 0, `${kind} happened ${n} times`);
  t.diagnostic(`changes: ${JSON.stringify(kinds)}`);
  const again = ownState(plain(store.state));
  assert.deepEqual(plain(again.assetRooms), recount(again), 'a snapshot’s JSON reads back the same index');
});

test('a name like __proto__ or constructor is an ordinary name, before and after a snapshot’s JSON (#352)', async () => {
  const store = new Store(null);
  const blobs = assetBlobs(mkdtempSync(join(tmpdir(), 'pb-index-')));
  const write = (req) => writeAsset(store, blobs, { kind: 'write', room: 'c1', type: 'x', author: 'dev', ...req });
  assert.equal((await write({ name: 'constructor', bytes: Buffer.from('a') })).ok, true, 'not taken by a prototype');
  assert.equal((await write({ name: '__proto__', bytes: Buffer.from('b') })).ok, true);
  assert.equal((await write({ name: '__PROTO__', bytes: Buffer.from('c') })).code, 'name-taken');
  store.state = ownState(plain(store.state));
  assert.equal(Object.getPrototypeOf(store.state.assetRooms.c1.names), null, 'its records have no prototype again');
  assert.equal((await write({ name: '__proto__', bytes: Buffer.from('d') })).code, 'name-taken', 'still one name after the reload');
  assert.equal((await write({ name: 'hasOwnProperty', bytes: Buffer.from('e') })).ok, true);
});
