// The top bar never makes a phone’s page wider than its window (#866, #837). On a phone the viewport widens to fit
// content that overflows, so a top bar a few pixels too wide, for the one frame before fitTopbar (shell.mjs) drops a
// crumb, lays the whole page out wider: the side thread’s text wraps shorter, the view scrolls to that end, and when the
// page snaps back the thread is hundreds of pixels above its end and stops following. #940’s Search button was 8 px too
// many at 375 px. Read after every change to the page and every frame from its start, since the wide layout lasts only
// until the top bar’s own ResizeObserver runs, before the frame is painted.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled } from './postbox.mjs';
import { citationFixes } from './work-pane.mjs';

/** @type {Awaited<ReturnType<typeof citationFixes>>} */
let ctx;
let topic;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  ctx = await citationFixes('topbar-no-overflow');
  ({ topic } = ctx);
});
test.afterAll(async () => ctx?.stop());
failOnPageErrors(test);
test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

test('#866 at 375 px on a phone, opening a side thread beside Work never lays the page out wider than the window', async ({ page }) => {
  await page.addInitScript(() => {
    const widest = /** @type {any} */ ((window.__widest = { page: 0, bar: 0, frames: 0 }));
    const tick = () => {
      const bar = document.querySelector('header.topbar');
      widest.page = Math.max(widest.page, document.documentElement.scrollWidth);
      if (bar) widest.bar = Math.max(widest.bar, bar.scrollWidth - bar.clientWidth);
      if (++widest.frames < 240) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const start = () =>
      new MutationObserver(() => {
        widest.page = Math.max(widest.page, document.documentElement.scrollWidth);
      }).observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
  await ctx.open(page, `/side/${topic}?work`);
  await settled(page);
  const widest = await page.evaluate(() => /** @type {any} */ (window).__widest);
  expect(widest.frames, 'frames sampled').toBeGreaterThan(5);
  expect(widest.page, 'the page’s widest frame').toBeLessThanOrEqual(375);
});
