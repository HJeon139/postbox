// #821a: a key or a click that takes 500 ms or more to answer is recorded in the page’s lag log, from the browser’s
// Event Timing, with its type, its timings and where it happened by role, never the room’s text. A quick one isn’t.
// The page’s own handlers are unchanged: the test makes a click slow by holding the main thread in a listener.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('lag-log');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const lagLog = (page) => page.evaluate(() => import('/app/js/lag-log.mjs').then((m) => m.lagLog.map((r) => ({ ...r }))));

/** A conversation open in the page, with the lag log started. */
async function open(page) {
  const t = Object.values(app.store.state.threads)[0];
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#composer-input')).toBeVisible();
  await expect.poll(() => page.evaluate(() => import('/app/js/lag-log.mjs').then((m) => m.lagLogStarted())), { message: 'the lag log started' }).toBe(true);
}

test('#821a a click on the composer that takes 600 ms to answer is recorded once, with its type, timings and role', async ({ page }) => {
  await open(page);
  // Holds the main thread for 600 ms on the next click, as a slow handler would.
  await page.evaluate(() =>
    document.addEventListener(
      'click',
      () => {
        const end = performance.now() + 600;
        while (performance.now() < end);
      },
      { once: true, capture: true },
    ),
  );
  await page.locator('#composer-input').click();
  await expect.poll(async () => (await lagLog(page)).length, { message: 'one lag record' }).toBe(1);
  const [r] = await lagLog(page);
  expect(r.kind).toBe('interaction');
  expect(['pointerdown', 'pointerup', 'click']).toContain(r.type);
  expect(r.duration).toBeGreaterThanOrEqual(500);
  expect(r.role).toBe('composer');
  expect(r.inputDelay + r.processing + r.presentation).toBeLessThanOrEqual(r.duration + 8);
  expect(Object.keys(r).sort()).toEqual(['at', 'duration', 'inputDelay', 'kind', 'presentation', 'processing', 'role', 'type']);
});

test('#821a a quick key or click isn’t recorded', async ({ page }) => {
  await open(page);
  await page.locator('#composer-input').click();
  await page.keyboard.type('hi');
  // A later slow click is the condition: once it’s recorded, the quick ones before it would have been too.
  await page.evaluate(() =>
    document.addEventListener(
      'click',
      () => {
        const end = performance.now() + 600;
        while (performance.now() < end);
      },
      { once: true, capture: true },
    ),
  );
  await page.locator('#composer-input').click();
  await expect.poll(async () => (await lagLog(page)).length, { message: 'the slow click recorded' }).toBe(1);
  expect((await lagLog(page))[0].duration).toBeGreaterThanOrEqual(500);
});
