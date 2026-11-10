// The right pane’s width is a custom property, `--pane-w`, that pane-width.mjs sets on the conversation’s shell, `.app`,
// whenever the pane opens, a route changes what it shows, the window resizes or its handle moves. Its readers are the
// pane and the conversation column beside it, but a custom property is inherited, so every element in the shell took
// the new value and was restyled: about 375,000 a time in the person’s Firefox profile on a room switch (#1150).
// Chromium’s trace gives each style recalc the number of elements it styled. Here the pane opens beside a long room,
// then its handle widens it, and each restyles what reads the width, not the room.

import { expect, test } from '@playwright/test';
import { WORK } from './pane.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright’s trace snapshot walks the page each action, which restyles it too.
test.use({ trace: 'off', viewport: { width: 1280, height: 800 } });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('pane-width-restyle-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** The elements Chromium restyled while `run` ran, and until the page held still after. */
async function restyledOver(page, run) {
  const browser = /** @type {import('@playwright/test').Browser} */ (page.context().browser());
  await browser.startTracing(page, { categories: ['devtools.timeline', 'blink'] });
  await run();
  await still(page);
  const trace = JSON.parse((await browser.stopTracing()).toString());
  let elements = 0;
  for (const e of trace.traceEvents ?? trace) {
    if (e.name === 'UpdateLayoutTree' && e.ph !== 'E') elements += e.args?.elementCount ?? 0;
  }
  return elements;
}

test('#1150 widening the pane beside a long room restyles what reads its width, not the room', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the style recalc counts come from Chromium’s trace');
  const conv = bigRoom(app, 'A pane beside a long room');
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${conv.id}"] > .item`)).toHaveCount(1000, { timeout: 15_000 });
  await still(page);
  await page.locator('#work-button').click();
  await expect(page.locator(WORK)).toBeVisible();
  await still(page);
  const total = await page.evaluate(() => document.querySelectorAll('.app *').length);
  const handle = page.locator('.rp-handle');
  await handle.focus();
  await still(page);
  const widening = await restyledOver(page, async () => {
    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '456');
  });
  // Both readers still take the new width: the pane, and the conversation column’s room beside it.
  const widths = await page.evaluate(() => [
    /** @type {HTMLElement} */ (document.querySelector('.rpane')).getBoundingClientRect().width,
    getComputedStyle(/** @type {HTMLElement} */ (document.querySelector('.app > .main'))).marginRight,
  ]);
  expect(widths, 'the pane’s width and the column’s margin beside it').toEqual([456, '456px']);
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ total, widening }) });
  // On main a new width restyled every element Chromium wasn’t skipping off screen, and Firefox all of them.
  expect(widening, `elements restyled widening the pane, of ${total}`).toBeLessThan(200);
});
