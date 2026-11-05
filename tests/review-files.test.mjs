// #780: show_block and update_block take files on a review block, read from the agent’s folders as show_app’s are
// (note as_BkHPLMds v3, §1–§3). Each is checked by its bytes (PNG, JPEG, GIF or WebP), copied into the blob store,
// and kept on the item with its name, kept ref, SHA-256, size, type and dimensions. An update without files keeps
// the list; one with files replaces it, and the files it replaces stay readable by their SHA-256.

import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { keptIfShown, keptRef, revisedFiles, servedReviewFile } from '../server/review-files.mjs';
import { png, reviewBlock, setup } from './review-files-fixture.mjs';

/** The bytes the route would serve for this file, or null. */
const reviewFile = async (...a) => (await servedReviewFile(...a))?.bytes ?? null;

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

test('#780 a name that could break the route’s header, such as one with a quote, is refused', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  for (const name of ['a"b.png', 'a b.png', 'a;b.png', '../a.png']) {
    const r = await f.call('show_block', reviewBlock(`q${name.length}${name.charCodeAt(1)}`, [{ name, path: 'figs/today.png' }]));
    assert.equal(r.isError, true, name);
    assert.match(r.text, /can’t name a file/, name);
  }
});

test('#780 a call refused at its last file stores none of its files', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await writeFile(join(f.folder, 'figs/a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const blobs = async () => (await readdir(join(f.root, 'blobs'), { recursive: true }).catch(() => [])).length;
  const before = await blobs();
  const r = await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }, { path: 'figs/a.svg' }]));
  assert.equal(r.isError, true, r.text);
  assert.equal(await blobs(), before, 'no blob left behind');
});

test('#780 pastFiles keeps each replaced file once, and never one still on the item', () => {
  const file = (name, sha256) => ({ name, ref: null, sha256, size: 1, type: 'image/png', width: 1, height: 1 });
  const a = file('a.png', 'a'.repeat(64));
  const b = file('a.png', 'b'.repeat(64));
  const once = revisedFiles({ files: [a], pastFiles: [] }, [b]);
  assert.deepEqual(once, { files: [b], pastFiles: [a] });
  const back = revisedFiles({ files: [b], pastFiles: [a] }, [a]);
  assert.deepEqual(back, { files: [a], pastFiles: [b] }, 'a is on the item again, so it isn’t past');
  const again = revisedFiles({ files: [a], pastFiles: [b, a] }, [b]);
  assert.deepEqual(again.pastFiles, [a], 'once each');
});

/** Every blob file in the fixture’s store, by name. */
const blobsIn = async (f) => (await readdir(join(f.root, 'blobs'), { recursive: true }).catch(() => [])).filter((p) => /[0-9a-f]{62}$/.test(p)).sort();

test('#780 an invalid block with valid files leaves the blob store as it was, and so does a refused update', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  const invalid = reviewBlock('bad', [{ path: 'figs/today.png' }]);
  invalid.block.format = 'nope';
  const r = await f.call('show_block', invalid);
  assert.equal(r.isError, true, r.text);
  assert.deepEqual(await blobsIn(f), [], 'the files passed their checks, but the block was refused: nothing is kept');
  const update = await f.call('update_block', reviewBlock('never-shown', [{ path: 'figs/today.png' }]));
  assert.equal(update.isError, true, update.text);
  assert.deepEqual(await blobsIn(f), [], 'an update of a block that isn’t shown keeps nothing either');
});

test('#780 a refused call never removes bytes another item already uses', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const before = await blobsIn(f);
  assert.equal(before.length, 1);
  const again = await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  assert.equal(again.isError, true, 'already shown');
  assert.deepEqual(await blobsIn(f), before);
  const [kept] = f.review('fig').files;
  assert.deepEqual(await reviewFile(f.rt, f.t.id, f.review('fig').id, 'today.png', kept.sha256), png(4, 3));
});

test('#780 two calls with the same bytes at once: the refused one leaves the kept one’s blob', async () => {
  const f = await setup();
  const bytes = png(4, 3);
  const a = await f.rt.blobs.put(bytes, { staged: true });
  const b = await f.rt.blobs.put(bytes, { staged: true });
  assert.deepEqual([a.fresh, b.fresh], [true, false]);
  await f.rt.blobs.settle([{ sha256: b.sha256, fresh: b.fresh }], true);
  await f.rt.blobs.settle([{ sha256: a.sha256, fresh: a.fresh }], false);
  assert.deepEqual(await f.rt.blobs.get(a.sha256), bytes, 'kept by the other call');
  // And the other way round: refused first, while the other still holds it.
  const c = await f.rt.blobs.put(png(8, 8), { staged: true });
  const d = await f.rt.blobs.put(png(8, 8), { staged: true });
  await f.rt.blobs.settle([{ sha256: c.sha256, fresh: c.fresh }], false);
  await f.rt.blobs.settle([{ sha256: d.sha256, fresh: d.fresh }], true);
  assert.deepEqual(await f.rt.blobs.get(c.sha256), png(8, 8), 'held by the other call when the first was refused');
});

test('#780 a plain put of bytes a staged call holds keeps them when that call is refused', async () => {
  const f = await setup();
  const bytes = png(4, 3);
  const staged = await f.rt.blobs.put(bytes, { staged: true });
  await f.rt.blobs.put(bytes); // an attachment of the same bytes, say
  await f.rt.blobs.settle([{ sha256: staged.sha256, fresh: staged.fresh }], false);
  assert.deepEqual(await f.rt.blobs.get(staged.sha256), bytes);
});

test('#780 keptIfShown keeps the files when the tool shows the block, and drops them when it refuses or throws', async () => {
  const settled = [];
  const app = { args: {}, settle: async (keep) => settled.push(keep) };
  await keptIfShown(app, () => ({ ok: true }));
  await keptIfShown(app, () => ({ ok: false }));
  await assert.rejects(() => keptIfShown(app, () => Promise.reject(new Error('boom'))), /boom/);
  assert.deepEqual(settled, [true, false, false]);
  assert.deepEqual(await keptIfShown({ args: {} }, () => ({ ok: true })), { ok: true }, 'an app’s files have nothing to settle');
});
