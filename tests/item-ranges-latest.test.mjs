// #1446: the conversation's newest items whatever range the page shows (app/js/item-ranges.mjs, latestItems), which
// the Work pane's In this chat reads. A jump to an old item replaces the range (reach(), ?around=): the newest it held
// stay kept as the tail. Loaded from a copy, as tests/item-ranges.test.mjs explains.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply } from '../shared/state.mjs';
import { tempDir } from './temp-dirs.mjs';

const shared = pathToFileURL(join(import.meta.dirname, '../shared/')).href;
const dir = await tempDir('pb-item-ranges-latest-');
for (const name of ['item-ranges.mjs', 'kept-items.mjs']) {
  const src = (await readFile(new URL(`../app/js/${name}`, import.meta.url), 'utf8')).replaceAll("'/shared/", `'${shared}`);
  await writeFile(join(dir, name), src);
}
const { gate, latestItems, loading, place } = await import(pathToFileURL(join(dir, 'item-ranges.mjs')).href);

const it = (n) => ({ id: `i${n}`, kind: 'agent', text: `m${n}` });
const items = (from, to) => Array.from({ length: to - from }, (_, k) => it(from + k));
const ids = (list) => list.map((x) => x.id);
/** An event as the page's client hears it: judged by gate, then applied where it says so. */
const hear = (state, ranges, type, d, seq) => {
  if (gate(state, ranges, type, d, seq) === 'apply') apply(state, type, d);
};
/** A load that replaces the range, as reach() and the opening load do. */
const replace = (state, ranges, start, list, total, seq) => {
  loading(ranges, 't');
  place(state, ranges, { threadId: 't', seq, start, total, items: list }, 'replace');
};

test('a jump away from the end keeps the newest items, and they follow what the page hears', () => {
  const state = { items: { t: [] } };
  const ranges = new Map();
  replace(state, ranges, 980, items(980, 1000), 1000, 10);
  replace(state, ranges, 0, items(0, 20), 1000, 11);
  assert.deepEqual(ids(state.items.t), ids(items(0, 20)), 'the jump shows the old items');
  const latest = latestItems(state, ranges.get('t'), 't');
  assert.deepEqual(ids(latest.slice(-10)), ids(items(990, 1000)), 'the last ten are still known');
  hear(state, ranges, 'item.add', { threadId: 't', item: it(1000) }, 12);
  assert.equal(latestItems(state, ranges.get('t'), 't').at(-1).id, 'i1000');
});

test('a range opened away from the end keeps no tail: the newest known are those added past its end', () => {
  const state = { items: { t: [] } };
  const ranges = new Map();
  replace(state, ranges, 0, items(0, 20), 1000, 10);
  assert.deepEqual(latestItems(state, ranges.get('t'), 't'), []);
  hear(state, ranges, 'item.add', { threadId: 't', item: it(1000) }, 11);
  assert.deepEqual(ids(latestItems(state, ranges.get('t'), 't')), ['i1000']);
});

test('a jump back to the end lets the kept tail go, and the range is the newest again', () => {
  const state = { items: { t: [] } };
  const ranges = new Map();
  replace(state, ranges, 980, items(980, 1000), 1000, 10);
  replace(state, ranges, 0, items(0, 20), 1000, 11);
  replace(state, ranges, 980, items(980, 1000), 1000, 12);
  assert.equal(ranges.get('t').tail, undefined);
  assert.equal(latestItems(state, ranges.get('t'), 't'), state.items.t);
});
