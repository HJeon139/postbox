import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicState } from '../server/public-state.mjs';
import { itemOf, positionOf, rebuildCount } from '../shared/item-index.mjs';
import { apply, emptyState } from '../shared/state.mjs';

// #712b: the reducer and every reader find an item by id through one index, kept outside the state, so a patch or a
// streamed chunk costs O(1) whatever the conversation's length (designs/508/712b-item-index.md).

/** A thread of n items, held behind a Proxy that counts the elements read. */
function countedThread(n) {
  const s = emptyState();
  const list = Array.from({ length: n }, (_, i) => ({ id: `it_${i}`, kind: 'agent', text: '' }));
  const reads = { n: 0 };
  s.items.t1 = new Proxy(list, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.n++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { s, reads };
}

for (const n of [1000, 10000]) {
  test(`#712b: a streamed chunk reads O(1) items, not the thread, at ${n} items`, () => {
    const { s, reads } = countedThread(n);
    apply(s, 'item.text', { threadId: 't1', id: `it_${n - 1}`, text: 'a' }); // the first lookup after a load may index the list
    reads.n = 0;
    for (let k = 0; k < 100; k++) apply(s, 'item.text', { threadId: 't1', id: `it_${n - 1}`, text: 'b' });
    assert.ok(reads.n <= 200, `100 chunks read ${reads.n} items`);
    assert.equal(s.items.t1[n - 1].text, `a${'b'.repeat(100)}`);
  });
}

test('#712b: a patch to an item early in a long thread reads O(1) items too', () => {
  const { s, reads } = countedThread(10000);
  apply(s, 'item.patch', { threadId: 't1', id: 'it_0', patch: { status: 'x' } });
  reads.n = 0;
  for (let k = 0; k < 100; k++) apply(s, 'item.patch', { threadId: 't1', id: 'it_9999', patch: { n: k } });
  assert.ok(reads.n <= 200, `100 patches read ${reads.n} items`);
  assert.equal(s.items.t1[9999].n, 99);
});

/** Every event kind that changes a thread's list, in a seeded mix. */
function scriptedMix(s, steps) {
  let next = 0;
  let seed = 7;
  const rand = (m) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % m;
  };
  const ids = () => (s.items.t1 ?? []).map((i) => i.id);
  for (let k = 0; k < steps; k++) {
    const have = ids();
    const pick = have[rand(Math.max(have.length, 1))];
    const op = have.length ? rand(4) : 0;
    if (op === 0) apply(s, 'item.add', { threadId: 't1', item: { id: `it_${next++}`, kind: 'agent', text: '' } });
    else if (op === 1) apply(s, 'item.text', { threadId: 't1', id: pick, text: 'x' });
    else if (op === 2) apply(s, 'item.patch', { threadId: 't1', id: pick, patch: { k } });
    else apply(s, 'item.move', { threadId: 't1', id: pick, stub: { id: `st_${next++}`, kind: 'moved', itemId: pick }, patch: {} });
    checkI1(s);
  }
}

/** I1: for every id in the list, and one that isn't, positionOf is findIndex. */
function checkI1(s) {
  const list = s.items.t1 ?? [];
  for (const it of list) {
    const first = list.findIndex((x) => x.id === it.id);
    assert.equal(positionOf(list, it.id), first, it.id);
  }
  assert.equal(positionOf(list, 'it_absent'), -1);
}

test('#712b I1: after every add, chunk, patch and move, positionOf equals findIndex, and nothing rebuilds', () => {
  const before = rebuildCount();
  scriptedMix(emptyState(), 400);
  assert.equal(rebuildCount(), before);
});

test('#712b I1: a list replaced by a load, or a thread removed and made again, gets its own index', () => {
  const s = emptyState();
  scriptedMix(s, 50);
  const loaded = JSON.parse(JSON.stringify(s));
  checkI1(loaded);
  apply(s, 'remove', { kind: 'thread', id: 't1' });
  assert.equal(itemOf(s.items.t1 ?? [], 'it_0'), undefined);
  apply(s, 'item.add', { threadId: 't1', item: { id: 'it_0', kind: 'user', text: 'new' } });
  assert.equal(itemOf(s.items.t1, 'it_0').text, 'new');
});

test('#712b I1: a held view’s copy of a list gets its own index, kept exact as held events apply to it', () => {
  const s = emptyState();
  scriptedMix(s, 60);
  // As server/store-held.mjs builds a view: a copy of the published list, an entry replaced by its clone before a
  // held event changes it, and each held event applied through the reducer on that copy.
  const entries = [...s.items.t1];
  const view = { items: { t1: entries } };
  const before = rebuildCount();
  for (const [k, it] of entries.slice(0, 20).entries()) {
    const at = positionOf(entries, it.id);
    entries[at] = structuredClone(entries[at]);
    apply(
      view,
      k % 2 ? 'item.text' : 'item.move',
      k % 2 ? { threadId: 't1', id: it.id, text: 'h' } : { threadId: 't1', id: it.id, stub: { id: `hs_${k}`, kind: 'moved' }, patch: {} },
    );
    checkI1(view);
  }
  assert.equal(rebuildCount(), before, 'a clone in place keeps its id, so nothing rebuilds');
  checkI1(s); // and the published list is untouched by the view’s index
});

test('#712b I1: the first of two items with one id wins, as find did', () => {
  const list = [
    { id: 'a', n: 1 },
    { id: 'a', n: 2 },
  ];
  assert.equal(itemOf(list, 'a').n, 1);
  list.push({ id: 'a', n: 3 });
  assert.equal(itemOf(list, 'a').n, 1);
});

test('#712b I2: the index is never in the state: the snapshot text and the page’s state are the same with and without it', () => {
  const plain = emptyState();
  const looked = emptyState();
  for (const s of [plain, looked]) scriptedMixNoLookups(s, 120);
  for (const it of looked.items.t1) itemOf(looked.items.t1, it.id);
  assert.equal(JSON.stringify(looked), JSON.stringify(plain));
  assert.equal(JSON.stringify(publicState(looked)), JSON.stringify(publicState(plain)));
  // JSON drops an array's own non-index properties, so check the list itself carries none.
  const onlyPlaces = (list) => Reflect.ownKeys(list).every((k) => k === 'length' || /^\d+$/.test(String(k)));
  assert.ok(onlyPlaces(looked.items.t1), 'the list carries no index of its own');
});

/** The same mix, without the checks, so one state is built with no lookups but the reducer’s own. */
function scriptedMixNoLookups(s, steps) {
  for (let k = 0; k < steps; k++) {
    const list = s.items.t1 ?? [];
    if (k % 3 === 0 || !list.length) apply(s, 'item.add', { threadId: 't1', item: { id: `it_${k}`, kind: 'agent', text: '' } });
    else if (k % 3 === 1) apply(s, 'item.text', { threadId: 't1', id: list[0].id, text: 'x' });
    else apply(s, 'item.move', { threadId: 't1', id: list[0].id, stub: { id: `st_${k}`, kind: 'moved' }, patch: {} });
  }
}

test('#712b I3: a stale hit, from a list changed behind the index, rebuilds and finds the right item, and the rebuild is counted', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(positionOf(list, 'b'), 1);
  const before = rebuildCount();
  list[1] = { id: 'z' }; // not through the reducer
  list[2] = { id: 'b' };
  assert.equal(positionOf(list, 'b'), 2);
  assert.equal(rebuildCount(), before + 1);
  assert.equal(positionOf(list, 'z'), 1);
});

test('#712b: a move keeps the stub findable at the old place and the item at the end', () => {
  const s = emptyState();
  for (const id of ['a', 'b', 'c']) apply(s, 'item.add', { threadId: 't1', item: { id, kind: 'agent' } });
  positionOf(s.items.t1, 'a'); // index it first, so the move has to keep it right
  apply(s, 'item.move', { threadId: 't1', id: 'a', stub: { id: 'st', kind: 'moved' }, patch: { moved: true } });
  assert.deepEqual(
    s.items.t1.map((i) => i.id),
    ['st', 'b', 'c', 'a'],
  );
  assert.equal(positionOf(s.items.t1, 'st'), 0);
  assert.equal(positionOf(s.items.t1, 'a'), 3);
  assert.equal(itemOf(s.items.t1, 'a').moved, true);
});
