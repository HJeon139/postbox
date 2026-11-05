// #780: show_block and update_block take files on a review block, read from the agent’s folders as show_app’s are
// (note as_BkHPLMds v3, §1–§3). Each is checked by its bytes (PNG, JPEG, GIF or WebP), copied into the blob store,
// and kept on the item with its name, kept ref, SHA-256, size, type and dimensions. An update without files keeps
// the list; one with files replaces it, and the files it replaces stay readable by their SHA-256.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { keptRef, reviewFile } from '../server/review-files.mjs';
import { png, reviewBlock, setup } from './review-files-fixture.mjs';

test('#780 a review block’s file is read from the agent’s folder, checked and kept with its revision', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(640, 480));
  const r = await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  assert.equal(r.isError, false, r.text);
  const [kept] = f.review('fig').files;
  assert.deepEqual(
    { ...kept, sha256: typeof kept.sha256 },
    { name: 'today.png', ref: 'figs/today.png', sha256: 'string', size: png(640, 480).length, type: 'image/png', width: 640, height: 480 },
  );
  assert.deepEqual(await reviewFile(f.rt, f.t.id, f.review('fig').id, 'today.png', kept.sha256), png(640, 480));
});

test('#780 the file was copied when it was shown: changing it later doesn’t change the block', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  await writeFile(join(f.folder, 'figs/today.png'), png(8, 8));
  const [kept] = f.review('fig').files;
  assert.deepEqual(await reviewFile(f.rt, f.t.id, f.review('fig').id, 'today.png', kept.sha256), png(4, 3));
});

test('#780 an update without files keeps the list; one with files replaces it, and the old file is still read by its SHA-256', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const first = f.review('fig').files[0].sha256;
  await f.call('update_block', reviewBlock('fig', undefined, '![Today](figs/today.png) and more'));
  assert.equal(f.review('fig').files[0].sha256, first, 'kept');
  await writeFile(join(f.folder, 'figs/today.png'), png(8, 8));
  await f.call('update_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const second = f.review('fig').files[0].sha256;
  assert.notEqual(second, first, 'replaced');
  const id = f.review('fig').id;
  assert.deepEqual(await reviewFile(f.rt, f.t.id, id, 'today.png', first), png(4, 3), 'the earlier revision’s figure');
  assert.deepEqual(await reviewFile(f.rt, f.t.id, id, 'today.png', second), png(8, 8));
});

test('#780 nothing outside the item’s own files is served: another name, another item, or an unknown SHA-256', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  await f.call('show_block', reviewBlock('other'));
  const it = f.review('fig');
  const sha = it.files[0].sha256;
  for (const [item, name, hash] of [
    [it.id, 'nope.png', sha],
    [f.review('other').id, 'today.png', sha],
    [it.id, 'today.png', 'f'.repeat(64)],
    ['it_missing', 'today.png', sha],
  ])
    assert.equal(await reviewFile(f.rt, f.t.id, item, name, hash), null, `${item} ${name}`);
});

test('#780 a ref is kept only when it’s a plain relative path; otherwise only the name matches', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('a', [{ path: 'figs/today.png' }]));
  await f.call('show_block', reviewBlock('b', [{ path: './figs/today.png' }]));
  await f.call('show_block', reviewBlock('c', [{ path: join(f.folder, 'figs/today.png') }]));
  assert.equal(f.review('a').files[0].ref, 'figs/today.png');
  assert.equal(f.review('b').files[0].ref, null, 'a ./ segment');
  assert.equal(f.review('c').files[0].ref, null, 'an absolute path');
});

test('#780 an SVG, an HTML file named .png, and a file that isn’t a review’s are refused with the rule named', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(f.folder, 'figs/b.png'), '<html><script>x()</script></html>');
  for (const path of ['figs/a.svg', 'figs/b.png']) {
    const r = await f.call('show_block', reviewBlock(`x-${path.length}`, [{ path }]));
    assert.equal(r.isError, true, path);
    assert.match(r.text, /PNG, JPEG, GIF or WebP/, path);
  }
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  const choice = { block: { id: 'q', type: 'choice', version: 1, fallback: 'Pick', options: [{ id: 'a', label: 'A' }], files: [{ path: 'figs/today.png' }] } };
  const r = await f.call('show_block', choice);
  assert.equal(r.isError, true);
  assert.match(r.text, /Only a review block carries files/);
});

test('#780 the limits: 8 files, no duplicate names, 5 MiB each, 20 MiB together, 8,192 px a side', async () => {
  const f = await setup();
  for (let i = 0; i < 9; i++) await writeFile(join(f.folder, `figs/f${i}.png`), png(4, 3));
  const nine = await f.call(
    'show_block',
    reviewBlock(
      'nine',
      Array.from({ length: 9 }, (_, i) => ({ path: `figs/f${i}.png` })),
    ),
  );
  assert.match(nine.text, /up to 8 files/);
  const dup = await f.call('show_block', reviewBlock('dup', [{ path: 'figs/f0.png' }, { name: 'f0.png', path: 'figs/f1.png' }]));
  assert.match(dup.text, /Two files are named “f0\.png”/);
  await writeFile(join(f.folder, 'figs/big.png'), png(4, 3, 5 * 1024 * 1024));
  assert.match((await f.call('show_block', reviewBlock('big', [{ path: 'figs/big.png' }]))).text, /over the limit/);
  for (let i = 0; i < 5; i++) await writeFile(join(f.folder, `figs/m${i}.png`), png(4, 3, 4.5 * 1024 * 1024));
  const many = await f.call(
    'show_block',
    reviewBlock(
      'many',
      Array.from({ length: 5 }, (_, i) => ({ path: `figs/m${i}.png` })),
    ),
  );
  assert.match(many.text, /20 MiB together/);
  await writeFile(join(f.folder, 'figs/wide.png'), png(8193, 1));
  assert.match((await f.call('show_block', reviewBlock('wide', [{ path: 'figs/wide.png' }]))).text, /8,192/);
  for (const id of ['nine', 'dup', 'big', 'many', 'wide']) assert.equal(f.review(id), undefined, `${id} wasn’t shown`);
});

test('#780 keptRef keeps only a plain relative path', () => {
  for (const [path, kept] of [
    ['figs/today.png', 'figs/today.png'],
    ['today.png', 'today.png'],
    ['./figs/today.png', null],
    ['figs/../today.png', null],
    ['figs//today.png', null],
    ['/abs/today.png', null],
    ['~/today.png', null],
    ['figs\\today.png', null],
    ['figs/today%2Epng', null],
    ['', null],
    [42, null],
  ])
    assert.equal(keptRef(path), kept, String(path));
});

test('#780 an answered review whose update changes only its files asks again', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const it = f.review('fig');
  const before = it.files[0].sha256;
  f.rt.patchItem(f.t.id, it.id, { answered: true, answer: { action: 'submit', values: { verdict: 'approve' }, read: true, revision: 1 } });
  await writeFile(join(f.folder, 'figs/today.png'), png(8, 8));
  // Its fallback changes too, which alone wouldn’t ask again (#286): the new figure must still reach the person.
  const next = reviewBlock('fig', [{ path: 'figs/today.png' }]);
  next.block.fallback = 'A review, with a new figure.';
  const r = await f.call('update_block', next);
  assert.equal(r.isError, false, r.text);
  assert.equal(f.review('fig').answered, false, 'the person sees a different figure, so it asks again');
  assert.equal(f.review('fig').revision, 2);
  assert.notEqual(f.review('fig').files[0].sha256, before, 'with the new figure');
});
