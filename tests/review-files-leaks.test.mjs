// #825's second review (critic): a review's images leave no blob behind when a later put fails, a refused show or
// update keeps none of its new bytes, and a blob gone from the store is the route's same 404, not a 500.

import assert from 'node:assert/strict';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { servedReviewFile, storeReviewFiles } from '../server/review-files.mjs';
import { png, reviewBlock, setup } from './review-files-fixture.mjs';

const blobsIn = async (f) => (await readdir(join(f.root, 'blobs'), { recursive: true }).catch(() => [])).filter((p) => /[0-9a-f]{62}$/.test(p)).sort();

test('#825 a put that fails at a later file settles the earlier staged ones, so none is left', async () => {
  const f = await setup();
  const put = f.rt.blobs.put.bind(f.rt.blobs);
  let n = 0;
  f.rt.blobs.put = async (buf, opts) => {
    n += 1;
    if (n === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return put(buf, opts);
  };
  const files = { 'a.png': png(4, 3), 'b.png': png(5, 3) };
  const read = async (x) => files[x.path];
  await assert.rejects(storeReviewFiles(f.rt, [{ path: 'a.png' }, { path: 'b.png' }], read), /no space left/);
  assert.deepEqual(await blobsIn(f), [], 'the first file’s staged blob is removed');
  assert.equal(f.rt.blobs.held.size, 0, 'and nothing still holds it');
});

test('#825 a review item whose blob is gone from the store gets null, so the route answers its same 404', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  assert.equal((await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]))).isError, false);
  const [kept] = f.review('fig').files;
  await rm(f.rt.blobs.pathOf(kept.sha256));
  assert.equal(await servedReviewFile(f.rt, f.t.id, f.review('fig').id, 'today.png', kept.sha256), null);
});

test('#828 showing a shown review again with new bytes is refused, and keeps none of them', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const before = await blobsIn(f);
  await writeFile(join(f.folder, 'figs/today.png'), png(6, 3));
  const again = await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  assert.equal(again.isError, true, again.text);
  assert.match(again.text, /already shown/);
  assert.deepEqual(await blobsIn(f), before, 'the new bytes aren’t kept');
});

test('#828 an update refused over an answer the agent hasn’t read keeps none of its new bytes', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const it = f.review('fig');
  f.rt.patchItem(f.t.id, it.id, { answered: true, answer: { action: 'submit', values: { verdict: 'approve' }, read: false, revision: 1, at: Date.now() } });
  const before = await blobsIn(f);
  await writeFile(join(f.folder, 'figs/today.png'), png(7, 3));
  const update = await f.call('update_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  assert.equal(update.isError, true, update.text);
  assert.match(update.text, /wasn’t applied/);
  assert.deepEqual(await blobsIn(f), before, 'the new bytes aren’t kept');
});

test('#825 a damaged blob is still an error, not passed off as a missing one', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]));
  const [kept] = f.review('fig').files;
  await writeFile(f.rt.blobs.pathOf(kept.sha256), 'not the bytes it was stored as');
  await assert.rejects(servedReviewFile(f.rt, f.t.id, f.review('fig').id, 'today.png', kept.sha256), /damaged/);
});
