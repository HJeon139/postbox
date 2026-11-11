// Home in a long room opened at its end (#866, #1155): the room's first item painted as soon as on main, though the
// page holds only the newest range when it opens. Measured from the key to the frame that paints the first item. And
// Home with focus in the transcript, as a click there or the UAT's scroll leaves it, goes to the first item in one
// press: the browser's own Home went only to the top of what was loaded, a range back each press.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, newestShown, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('home-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Presses Home and resolves how long until the first item is on the page and painted, in ms. */
const home = (page, first) =>
  page.evaluate(
    (k) =>
      new Promise((done) => {
        const t0 = performance.now();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        const seen = () => {
          if (!document.querySelector(`#main > [data-key="${k}"]`)) return requestAnimationFrame(seen);
          requestAnimationFrame(() => done(Math.round(performance.now() - t0)));
        };
        seen();
      }),
    first,
  );

test('#1155 Home in a 10,000-item room paints its first item within main’s time', async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: '10,000 items', personaIds: [] });
  seedBigRoom(app.store, room.id, { count: 10_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const first = app.store.items(room.id)[0].id;
  const times = [];
  for (let i = 0; i < 6; i++) {
    await page.goto(`${app.origin}/?visit=${i}#/t/${room.id}`); // a load of its own each time
    await synced(page, app);
    await newestShown(page, app, room.id);
    await settled(page);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    times.push(await home(page, first));
    await expect(page.locator(`#main > [data-key="${first}"]`)).toBeInViewport();
  }
  const sorted = times.slice(1).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  console.log(`HOME ms ${times.join(', ')}; median of the last five ${median}`);
  test.info().annotations.push({ type: 'measured', description: `Home, ms: ${times.join(', ')}` });
  // Main paints it in about 13 ms here (median of five, measured beside this branch): no fetch, one rebuild.
  expect(median, `ms from Home to the first item painted: ${times.join(', ')}`).toBeLessThanOrEqual(20);
});

test('#1155 Home with focus in the transcript goes to the room’s first item in one press', async ({ page }) => {
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: '3,000 items', personaIds: [] });
  seedBigRoom(app.store, room.id, { count: 3000 });
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await newestShown(page, app, room.id);
  await settled(page);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#main.transcript')).focus({ preventScroll: true }));
  await page.keyboard.press('Home');
  await expect(page.locator(`#main > [data-key="${app.store.items(room.id)[0].id}"]`), 'the first item, after one press').toBeInViewport();
});

test('#1155 Home before the room’s first items are kept loads them, and says how long that takes', async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: '10,000 items, Home at once', personaIds: [] });
  seedBigRoom(app.store, room.id, { count: 10_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const first = app.store.items(room.id)[0].id;
  // The idle load of the first items is held, so each Home here runs before it: a load and one build. Only that load
  // is held, the first of each visit; Home's own goes through.
  /** @type {{ hold: boolean, go: () => void }} */
  const idle = { hold: true, go: () => {} };
  await page.route(`**/api/threads/${room.id}/items?first*`, async (route) => {
    if (idle.hold) {
      idle.hold = false;
      await new Promise((r) => (idle.go = () => r(undefined)));
    }
    await route.continue();
  });
  const times = [];
  for (let i = 0; i < 6; i++) {
    idle.hold = true;
    await page.goto(`${app.origin}/?early=${i}#/t/${room.id}`);
    await synced(page, app);
    await newestShown(page, app, room.id);
    await settled(page);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    const kept = await page.evaluate((id) => import('/app/js/client.mjs').then(({ client }) => !!client.ranges.get(id)?.head), room.id);
    expect(kept, 'the first items aren’t kept yet').toBe(false);
    times.push(await home(page, first));
    idle.go();
  }
  const sorted = times.slice(1).sort((a, b) => a - b);
  console.log(`HOME early ms ${times.join(', ')}; median of the last five ${sorted[sorted.length >> 1]}`);
  test.info().annotations.push({ type: 'measured', description: `Home before the first items are kept, ms: ${times.join(', ')}` });
});
