// #856, the layer Postbox draws over an app in its review holds the latest render’s view of the review, and that
// render’s element and its room. A review the page let go of, as when the person leaves its room, takes its layer
// with it: nothing of Postbox’s keeps the old room alive until the page reloads.

import { expect, test } from '@playwright/test';
import { regionRoom } from './review-app-region-fixture.mjs';

const room = regionRoom('review-app-region-leak');
const { review } = room;

// Tracing is off: Playwright’s DOM snapshots hold references to elements they recently snapped.
test.use({ viewport: { width: 1280, height: 900 }, trace: 'off' });

/**
 * How many layers over a review’s app the page’s heap holds for this item, after a full garbage collection: Chrome’s
 * own count of live objects, attached to the page or not. @param {import('@playwright/test').Page} page @param {string} itemId
 */
async function layersHeld(page, itemId) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.enable');
    for (let i = 0; i < 2; i++) await cdp.send('HeapProfiler.collectGarbage');
    const proto = await cdp.send('Runtime.evaluate', { expression: 'HTMLDivElement.prototype' });
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId ?? '' });
    const counted = await cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId,
      functionDeclaration: 'function (id) { return this.filter((el) => el.classList.contains("rv-marks") && el.dataset.marks === id).length; }',
      arguments: [{ value: itemId }],
      returnByValue: true,
    });
    await cdp.send('Runtime.releaseObject', { objectId: objects.objectId });
    if (proto.result.objectId) await cdp.send('Runtime.releaseObject', { objectId: proto.result.objectId });
    return /** @type {number} */ (counted.result.value);
  } finally {
    await cdp.detach();
  }
}

test('#856 leaving a room with an app review lets its layer, and the render it saw, go', async ({ page }) => {
  const first = await review(page);
  const itemId = /** @type {string} */ (await first.block.getAttribute('data-key'));
  await first.block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await first.block.getByRole('button', { name: 'Mark a part of the app' }).click();
  expect(await layersHeld(page, itemId), 'the layer is held while its review is on the page').toBe(1);
  // Another room, in the same page, as the person goes to another conversation.
  await review(page);
  await expect(page.locator(`[data-marks="${itemId}"]`), 'the first room is gone from the page').toHaveCount(0);
  await expect.poll(() => layersHeld(page, itemId), { message: 'and nothing keeps its layer' }).toBe(0);
});
