// The page's ranges of a conversation's items (app/js/item-ranges.mjs, #1155): the events it hears after a load's seq,
// before the load's answer lands, reach the items the answer brings, once. The module imports /shared/ as the browser
// serves it, so it's loaded here from a copy, with the module it imports, whose imports point at the files.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply } from '../shared/state.mjs';
import { tempDir } from './temp-dirs.mjs';

const shared = pathToFileURL(join(import.meta.dirname, '../shared/')).href;
const dir = await tempDir('pb-item-ranges-');
for (const name of ['item-ranges.mjs', 'kept-items.mjs']) {
  const src = (await readFile(new URL(`../app/js/${name}`, import.meta.url), 'utf8')).replaceAll("'/shared/", `'${shared}`);
  await writeFile(join(dir, name), src);
}
const file = join(dir, 'item-ranges.mjs');
const { beyondItem, gate, loading, place, placeAround, placeHead, placeTail } = await import(pathToFileURL(file).href);

const it = (n, text = `m${n}`) => ({ id: `i${n}`, kind: 'message', text });
/** An event as the page's client hears it (client.mjs, hear): judged by gate, then applied where it says so. */
const hear = (
  /** @type {any} */ state,
  /** @type {Map<string, any>} */ ranges,
  /** @type {string} */ type,
  /** @type {any} */ d,
  /** @type {number} */ seq,
) => {
  if (gate(state, ranges, type, d, seq) === 'apply') apply(state, type, d);
};
const items = (from, to) => Array.from({ length: to - from }, (_, k) => it(from + k));

test('a streamed chunk heard after an after-load’s seq, before its answer, reaches the item', () => {
  // Server: t has 10 items; the page holds [0,5) as of seq 10, then grows after i4.
  const state = { items: { t: items(0, 5) } };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 0, total: 10, items: items(0, 5) }, 'replace');
  loading(ranges, 't'); // grow('after') in flight; the server answers as of seq 11
  // seq 12 happens after the server answered, and the stream is quicker than the HTTP answer.
  const v = gate(state, ranges, 'item.text', { threadId: 't', id: 'i7', text: '+chunk' }, 12);
  assert.equal(v, 'apply'); // a no-op: i7 isn't held
  place(state, ranges, { threadId: 't', seq: 11, start: 5, total: 10, items: items(5, 10) }, 'after');
  assert.equal(state.items.t.find((x) => x.id === 'i7').text, 'm7+chunk');
});

test('an item.patch heard after a before-load’s seq reaches the item the load brings', () => {
  const state = { items: { t: items(5, 10) } };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 5, total: 10, items: items(5, 10) }, 'replace');
  loading(ranges, 't');
  gate(state, ranges, 'item.patch', { threadId: 't', id: 'i2', patch: { text: 'edited' } }, 12);
  place(state, ranges, { threadId: 't', seq: 11, start: 0, total: 10, items: items(0, 5) }, 'before');
  assert.equal(state.items.t.find((x) => x.id === 'i2').text, 'edited');
});

test('a message added after a move, both heard during a replace load, is kept', () => {
  // Server at answer (seq 10): i0..i4. Then seq 11 moves i1 to the end (stub s1 in its place), seq 12 adds i5.
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  gate(state, ranges, 'item.move', { threadId: 't', id: 'i1', stub: { id: 's1', kind: 'moved' }, patch: {} }, 11);
  gate(state, ranges, 'item.add', { threadId: 't', item: it(5) }, 12);
  place(state, ranges, { threadId: 't', seq: 10, start: 0, total: 5, items: items(0, 5) }, 'replace');
  assert.deepEqual(
    state.items.t.map((x) => x.id),
    ['i0', 's1', 'i2', 'i3', 'i4', 'i1', 'i5'],
  );
});

test('the kept head, for Home, comes with the opening load, follows what the page hears, and goes in place whole', () => {
  // The page opens on [90,100) as of seq 11, with the first five (the head) in the same answer; a patch to one of them
  // came at seq 12, before the answer landed.
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  gate(state, ranges, 'item.patch', { threadId: 't', id: 'i1', patch: { text: 'edited' } }, 12);
  place(state, ranges, { threadId: 't', seq: 11, start: 90, total: 100, items: items(90, 100), head: items(0, 5) }, 'replace');
  gate(state, ranges, 'item.text', { threadId: 't', id: 'i2', text: '+chunk' }, 13);
  gate(state, ranges, 'item.move', { threadId: 't', id: 'i3', stub: { id: 's3', kind: 'moved' }, patch: {} }, 14);
  gate(state, ranges, 'item.add', { threadId: 't', item: it(100) }, 15);
  assert.equal(placeHead(state, ranges, 't', 15), true);
  assert.deepEqual(
    state.items.t.map((x) => `${x.id}:${x.text ?? ''}`),
    ['i0:m0', 'i1:edited', 'i2:m2+chunk', 's3:', 'i4:m4'],
  );
  assert.equal(ranges.get('t').start, 0);
});

test('a joined load that doesn’t touch the range isn’t placed, and the latest range is asked for again', () => {
  // The page holds [80,100); a load asked for the 20 before item 50, from a range it held before a reload.
  const state = { items: { t: items(80, 100) } };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 80, total: 100, items: items(80, 100) }, 'replace');
  loading(ranges, 't');
  const again = place(state, ranges, { threadId: 't', seq: 11, start: 30, total: 100, items: items(30, 50) }, 'before');
  assert.equal(again, true, 'load the latest again');
  assert.deepEqual(
    state.items.t.map((x) => x.id),
    items(80, 100).map((x) => x.id),
    'the range is as it was, with no hole',
  );
  assert.equal(ranges.get('t').start, 80);
});

test('after Home, the newest range is kept as the tail, follows what the page hears, and End puts it back whole', () => {
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 95, total: 100, items: items(95, 100), head: items(0, 5) }, 'replace');
  assert.equal(placeHead(state, ranges, 't', 10), true, 'Home');
  hear(state, ranges, 'item.text', { threadId: 't', id: 'i97', text: '+chunk' }, 11);
  hear(state, ranges, 'item.add', { threadId: 't', item: it(100) }, 12);
  hear(state, ranges, 'item.patch', { threadId: 't', id: 'i1', patch: { text: 'edited' } }, 13);
  assert.equal(placeTail(state, ranges, 't', 13), true, 'End');
  assert.deepEqual(
    state.items.t.map((x) => `${x.id}:${x.text}`),
    ['i95:m95', 'i96:m96', 'i97:m97+chunk', 'i98:m98', 'i99:m99', 'i100:m100'],
  );
  assert.equal(ranges.get('t').start, 95, 'where the newest six start in 101');
  assert.equal(placeHead(state, ranges, 't', 13), true, 'Home again, from the head kept by End');
  assert.equal(state.items.t[1].text, 'edited');
});

test('the items kept around an ask follow what the page hears, and a jump to it puts them in place, the newest kept for End', () => {
  // The page opens on [95,100) as of seq 10 with [38,43) kept around the ask at 40; a patch to it came at seq 11, before
  // the answer landed.
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  gate(state, ranges, 'item.patch', { threadId: 't', id: 'i40', patch: { text: 'answered' } }, 11);
  place(
    state,
    ranges,
    { threadId: 't', seq: 10, start: 95, total: 100, items: items(95, 100), asks: [{ id: 'i40', start: 38, items: items(38, 43) }] },
    'replace',
  );
  hear(state, ranges, 'item.text', { threadId: 't', id: 'i41', text: '+chunk' }, 12);
  hear(state, ranges, 'item.add', { threadId: 't', item: it(100) }, 13);
  assert.equal(placeAround(state, ranges, 't', 'i77', 13), false, 'nothing kept around an item that isn’t near an ask');
  assert.equal(placeAround(state, ranges, 't', 'i40', 13), true, 'the jump');
  assert.deepEqual(
    state.items.t.map((x) => `${x.id}:${x.text}`),
    ['i38:m38', 'i39:m39', 'i40:answered', 'i41:m41+chunk', 'i42:m42'],
  );
  assert.equal(ranges.get('t').start, 38);
  hear(state, ranges, 'item.patch', { threadId: 't', id: 'i40', patch: { text: 'and again' } }, 14);
  assert.equal(ranges.get('t').asks[0].items[2].text, 'and again', 'the kept copy follows too, for the next jump');
  assert.equal(state.items.t[2].text, 'and again', 'and the range, once');
  assert.equal(placeTail(state, ranges, 't', 14), true, 'End, with no load');
  assert.deepEqual(
    state.items.t.map((x) => x.id),
    ['i95', 'i96', 'i97', 'i98', 'i99', 'i100'],
  );
});

test('at Home, an item moved forward from outside the kept tail joins it, so End puts back the newest items as they are', () => {
  // The page opens on [95,100) with the first five kept; Home puts them in place and keeps [95,100) as the tail. Then
  // item 3, on the page, moves to the end: its stub stays at 3, and it's the conversation's 101st item.
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 95, total: 100, items: items(95, 100), head: items(0, 5) }, 'replace');
  assert.equal(placeHead(state, ranges, 't', 10), true, 'Home');
  hear(state, ranges, 'item.move', { threadId: 't', id: 'i3', stub: { id: 's3', kind: 'moved' }, patch: { text: 'updated' } }, 11);
  assert.equal(placeTail(state, ranges, 't', 11), true, 'End, with no load');
  assert.deepEqual(
    state.items.t.map((x) => `${x.id}:${x.text ?? ''}`),
    ['i95:m95', 'i96:m96', 'i97:m97', 'i98:m98', 'i99:m99', 'i3:updated'],
  );
  assert.equal(ranges.get('t').start, 95, 'where the newest six start in 101');
});

test('at Home, an item the page doesn’t hold moved forward lets the tail go, so End loads the newest items', () => {
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 95, total: 100, items: items(95, 100), head: items(0, 5) }, 'replace');
  assert.equal(placeHead(state, ranges, 't', 10), true, 'Home');
  hear(state, ranges, 'item.move', { threadId: 't', id: 'i50', stub: { id: 's50', kind: 'moved' }, patch: {} }, 11);
  assert.equal(placeTail(state, ranges, 't', 11), false, 'no tail to put back: End loads');
});

test('read at the top, an item moved forward leaves its stub on the page and is kept past the range’s end, as an add is', () => {
  const state = { items: {} };
  const ranges = new Map();
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq: 10, start: 0, total: 100, items: items(0, 5) }, 'replace');
  const verdict = gate(state, ranges, 'item.move', { threadId: 't', id: 'i3', stub: { id: 's3', kind: 'moved' }, patch: { text: 'updated' } }, 11);
  assert.equal(verdict, 'moved', 'the page draws the stub, and counts the item past the end');
  assert.equal(state.items.t[3].id, 's3');
  assert.equal(beyondItem(ranges.get('t'), 't', 'i3')?.text, 'updated');
  assert.equal(ranges.get('t').total, 101);
});
