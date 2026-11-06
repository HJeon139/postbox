// #828, from #825's review: a call's review images are kept only when an item took them (keptIfShown, given.held),
// and an invalid show_block's item carries none. The rest of #780's specs are in review-files.test.mjs.

import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { keptIfShown, servedReviewFile } from '../server/review-files.mjs';
import { png, reviewBlock, setup } from './review-files-fixture.mjs';

const reviewFile = async (...a) => (await servedReviewFile(...a))?.bytes ?? null;
const blobsIn = async (f) => (await readdir(join(f.root, 'blobs'), { recursive: true }).catch(() => [])).filter((p) => /[0-9a-f]{62}$/.test(p)).sort();

test('#828 an invalid show_block’s item carries no files, so its fallback names no image the route can’t serve', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  const invalid = reviewBlock('bad', [{ path: 'figs/today.png' }]);
  invalid.block.format = 'nope';
  assert.equal((await f.call('show_block', invalid)).isError, true);
  const item = f.store.items(f.t.id).find((i) => i.kind === 'block' && i.raw?.id === 'bad');
  assert.ok(item, 'the invalid show is still an item, with its fallback');
  assert.equal(item.files, undefined);
  assert.deepEqual(await blobsIn(f), []);
});

test('#828 a call’s review files are kept only when an item took them, whatever the reply says', async () => {
  const settled = [];
  const app = { args: {}, files: [{ name: 'a.png' }], settle: async (keep) => settled.push(keep) };
  await keptIfShown(app, () => ({ ok: true, message: 'Shown, but no item took the files.' }));
  await keptIfShown(app, (given) => {
    given.held = true;
    return { ok: true };
  });
  await assert.rejects(
    keptIfShown(app, (given) => {
      given.held = true;
      throw new Error('after the item took them');
    }),
  );
  await assert.rejects(
    keptIfShown(app, () => {
      throw new Error('before any item took them');
    }),
  );
  assert.deepEqual(settled, [false, true, true, false]);
});

test('#828 a shown review, an update that asks again, and one that changes only its fallback each keep the files', async () => {
  const f = await setup();
  await writeFile(join(f.folder, 'figs/today.png'), png(4, 3));
  assert.equal((await f.call('show_block', reviewBlock('fig', [{ path: 'figs/today.png' }]))).isError, false);
  assert.equal((await blobsIn(f)).length, 1);
  await writeFile(join(f.folder, 'figs/today.png'), png(5, 3));
  assert.equal((await f.call('update_block', reviewBlock('fig', [{ path: 'figs/today.png' }]))).isError, false);
  assert.equal((await blobsIn(f)).length, 2, 'the new revision’s file is kept, and the old one for pastFiles');
  const [now] = f.review('fig').files;
  assert.deepEqual(await reviewFile(f.rt, f.t.id, f.review('fig').id, 'today.png', now.sha256), png(5, 3));
});
