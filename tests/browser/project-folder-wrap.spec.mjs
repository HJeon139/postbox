// A project whose folder ends in a long name with no space printed it on one line on the project’s own page, so the
// page was 1,056 px wide in a 375 px window, and 1,410 px at 1280 px (UAT of 26 Nov, the same class as #1534).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced, windowWidth } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('project-folder-wrap');
  app.store.emit('project', { id: 'pr_long', name: 'UAT long', folder: `${app.root}/${'n'.repeat(120)}` });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const width of [375, 1280])
  test(`a project’s page wraps a long folder, and the page fits a ${width} px window`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/#/p/pr_long`);
    await synced(page, app);
    await expect(page.getByRole('heading', { name: 'UAT long' })).toBeVisible();
    await settled(page);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `the page is ${wide} px wide`).toBeLessThanOrEqual(windowWidth(page));
  });
