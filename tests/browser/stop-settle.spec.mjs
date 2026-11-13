// A spec’s Postbox stops cleanly while the store is still writing (#1314): stop() (tests/browser/postbox.mjs) waits
// for the store’s writes under way before it closes, so a big room’s last snapshot on a busy runner doesn’t fail the
// spec as a disk that isn’t answering. The store’s own bound, 3 s, stays the product’s.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { startPostbox } from './postbox.mjs';

test('Postbox stops cleanly when the store’s writer pass takes longer than its 3 s bound', async () => {
  test.setTimeout(30_000);
  const app = await startPostbox('stop-settle');
  arrange.slowWriterPass(app.rt, 4000);
  await expect(app.stop()).resolves.toBeUndefined();
});
