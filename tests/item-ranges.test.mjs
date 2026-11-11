// The page's ranges of a conversation's items (app/js/item-ranges.mjs, #1155): the events it hears after a load's seq,
// before the load's answer lands, reach the items the answer brings, once. The module imports /shared/ as the browser
// serves it, so it's loaded here from a copy whose imports point at the files.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDir } from './temp-dirs.mjs';

const shared = pathToFileURL(join(import.meta.dirname, '../shared/')).href;
const src = (await readFile(new URL('../app/js/item-ranges.mjs', import.meta.url), 'utf8')).replaceAll("'/shared/", `'${shared}`);
const file = join(await tempDir('pb-item-ranges-'), 'item-ranges.mjs');
await writeFile(file, src);
const { gate, loading, place } = await import(pathToFileURL(file).href);

const it = (n, text = `m${n}`) => ({ id: `i${n}`, kind: 'message', text });
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
