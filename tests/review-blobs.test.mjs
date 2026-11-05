// #780: a review's images are staged puts in the blob store, kept only when the block is shown or updated
// (keptIfShown). A refused call removes only what it wrote itself, never bytes another call, item or ordinary put of
// the same bytes keeps or still has in flight.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keptIfShown } from '../server/review-files.mjs';
import { png, setup } from './review-files-fixture.mjs';

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

test('#780 a refused review call never removes bytes an ordinary put of them had in flight (critic’s probe)', async () => {
  const f = await setup();
  const bytes = png(6, 5);
  // The ordinary put starts first, before any staged hold exists; both find nothing on disk, and both write.
  const plain = f.rt.blobs.put(bytes);
  const staged = f.rt.blobs.put(bytes, { staged: true });
  const [, s] = await Promise.all([plain, staged]);
  await f.rt.blobs.settle([{ sha256: s.sha256, fresh: s.fresh }], false);
  assert.deepEqual(await f.rt.blobs.get(s.sha256), bytes, 'the ordinary put’s bytes are still there');
});
