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
 * How many review block elements the page’s heap holds for this item, after forced GCs: Chrome’s own count of live
 * objects, attached to the page or not. Counting the block proves both the layer release and focus cleanup (#856).
 * @param {import('@playwright/test').Page} page @param {string} itemId
 */
async function blocksHeld(page, itemId) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.enable');
    for (let i = 0; i < 2; i++) await cdp.send('HeapProfiler.collectGarbage');
    const proto = await cdp.send('Runtime.evaluate', { expression: 'HTMLDivElement.prototype' });
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId ?? '' });
    const counted = await cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId,
      functionDeclaration: 'function (id) { return this.filter((el) => el.dataset.key === id).length; }',
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

test('#856 leaving a room with an app review lets its block, layer, and the render it saw, go', async ({ page }) => {
  const first = await review(page);
  const itemId = /** @type {string} */ (await first.block.getAttribute('data-key'));
  // Start and stop marking from the keyboard, so lastDown (pointerdown) isn’t what holds a node of the old room.
  const btn = first.block.getByRole('button', { name: 'Mark a part of the app' });
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(first.block.locator('.rv-marks.marking')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(btn).toBeFocused();
  expect(await blocksHeld(page, itemId), 'the review block is held while on the page').toBeGreaterThan(0);
  // Another room, in the same page, as the person goes to another conversation.
  await review(page);
  await expect(page.locator(`[data-key="${itemId}"]`), 'the first room is gone from the page').toHaveCount(0);
  await expect.poll(() => blocksHeld(page, itemId), { message: 'and nothing keeps its review block or layer' }).toBe(0);
});
