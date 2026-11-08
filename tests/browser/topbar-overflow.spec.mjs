// A top bar too wide for the window never widens the page (#72, #837). fitTopbar measures the bar with nothing
// dropped before it drops the crumb and the demo’s sentence, and at 375 px that bar is wider than the window. Its
// overflow made the page wider for that layout: on a phone the whole page reflowed, and the transcripts’ scroll moved
// up, so a conversation opened at its end stopped following it. On the demo’s “Citation fixes” (work-pane.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled } from './postbox.mjs';
import { citationFixes, SIZES, THREAD } from './work-pane.mjs';

/** @type {Awaited<ReturnType<typeof citationFixes>>} */
let ctx;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  ctx = await citationFixes('topbar-overflow');
});
test.afterAll(async () => {
  await ctx?.stop();
});
failOnPageErrors(test);

const phone = SIZES.find((s) => s.phone);
test.use({ viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

test('#837 with the top bar measured whole, the page stays the window’s width and the thread’s scroll doesn’t move', async ({ page }) => {
  await ctx.open(page, `/side/${ctx.topic}?work`);
  await settled(page);
  const measured = await page.evaluate((sel) => {
    const bar = /** @type {HTMLElement} */ (document.querySelector('header.topbar'));
    const body = /** @type {HTMLElement} */ (document.querySelector(`${sel} .sp-body`));
    const was = { drop: bar.dataset.drop ?? '', top: body.scrollTop, y: scrollY };
    // As fitTopbar does: nothing dropped, then measured.
    bar.dataset.drop = '';
    const wide = { bar: bar.scrollWidth, page: document.documentElement.scrollWidth, top: body.scrollTop, y: scrollY };
    bar.dataset.drop = was.drop;
    return { was, wide, window: innerWidth };
  }, THREAD);
  // A check that can fail: the bar really is wider than the window with nothing dropped.
  expect(measured.wide.bar, 'the whole bar is wider than the window').toBeGreaterThan(measured.window);
  expect(measured.wide.page, 'the page stays the window’s width').toBe(measured.window);
  expect([measured.wide.top, measured.wide.y], 'the thread’s and the window’s scroll').toEqual([measured.was.top, measured.was.y]);
  await settled(page);
  await expect(page.locator(`${THREAD} .sp-body .transcript`)).toHaveAttribute('data-view-mode', 'following');
});
