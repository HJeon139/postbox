// Home in a long room opened at its end (#866, #1155): the room's first item painted with the work main does for it,
// no load and no more layouts, though the page holds only the newest range when it opens; the time from the key to
// the frame that paints it is recorded. And
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

/** Presses a key and resolves how long until an item is on the page and painted, in ms; -1 past 3 s. */
const press = (page, key, item) =>
  page.evaluate(
    ([name, k]) =>
      new Promise((done) => {
        const t0 = performance.now();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
        const seen = () => {
          if (performance.now() - t0 > 3000) return done(-1);
          if (!document.querySelector(`#main > [data-key="${k}"]`)) return requestAnimationFrame(seen);
          requestAnimationFrame(() => done(Math.round(performance.now() - t0)));
        };
        seen();
      }),
    [key, item],
  );
/** Presses Home and resolves how long until the first item is painted. */
const home = (page, first) => press(page, 'Home', first);

/** Main's layouts for Home in this room, measured with this case on origin/main beside #1155's branch: 2 a press. */
const MAIN_LAYOUTS = 2;

test('#1155 Home in a 10,000-item room does main’s work: no load, and no more layouts', async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: '10,000 items', personaIds: [] });
  seedBigRoom(app.store, room.id, { count: 10_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const first = app.store.items(room.id)[0].id;
  let loads = 0;
  page.on('request', (r) => r.url().includes(`/api/threads/${room.id}/items`) && loads++);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layoutsNow = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  const runs = [];
  for (let i = 0; i < 6; i++) {
    await page.goto(`${app.origin}/?visit=${i}#/t/${room.id}`); // a load of its own each time
    await synced(page, app);
    await newestShown(page, app, room.id);
    // The room's first items, loaded while the page is idle, are kept before Home is pressed: on a slow runner the
    // idle moment can come later, and Home before it is the next case's.
    await expect.poll(() => page.evaluate((id) => import('/app/js/client.mjs').then(({ client }) => !!client.ranges.get(id)?.head), room.id)).toBe(true);
    await settled(page);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    const loadsBefore = loads;
    const layoutsBefore = await layoutsNow();
    const ms = await home(page, first);
    runs.push({ ms, loads: loads - loadsBefore, layouts: (await layoutsNow()) - layoutsBefore });
    await expect(page.locator(`#main > [data-key="${first}"]`)).toBeInViewport();
  }
  console.log(`HOME ${JSON.stringify(runs)}`);
  // Time is recorded, not asserted: it's the runner's. Here it was 10–14 ms, and 9–14 on main, on the same machine.
  test.info().annotations.push({ type: 'measured', description: `Home: ${JSON.stringify(runs)}` });
  expect(
    runs.map((r) => r.loads),
    'items loaded by Home: none, as on main',
  ).toEqual(runs.map(() => 0));
  for (const r of runs) expect(r.layouts, `layouts for Home: ${JSON.stringify(runs)}`).toBeLessThanOrEqual(MAIN_LAYOUTS);
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

test('#1155 Home at once after a 10,000-item room opens does main’s work: no load, and no more layouts', async ({ page }) => {
  test.setTimeout(120_000);
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: '10,000 items, Home at once', personaIds: [] });
  seedBigRoom(app.store, room.id, { count: 10_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const first = app.store.items(room.id)[0].id;
  // A load of the first items on its own, as an idle prefetch would make, never answers here: Home pressed as soon as
  // the room shows must not need anything the page hasn't got by then, as on main, which held every item.
  await page.route(`**/api/threads/${room.id}/items?first*`, () => {});
  let loads = 0;
  page.on('request', (r) => r.url().includes(`/api/threads/${room.id}/items`) && loads++);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layoutsNow = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  const runs = [];
  for (let i = 0; i < 6; i++) {
    await page.goto(`${app.origin}/?early=${i}#/t/${room.id}`);
    await synced(page, app);
    await newestShown(page, app, room.id);
    await settled(page);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    const loadsBefore = loads;
    const layoutsBefore = await layoutsNow();
    const ms = await home(page, first);
    runs.push({ ms, loads: loads - loadsBefore, layouts: (await layoutsNow()) - layoutsBefore });
  }
  console.log(`HOME early ${JSON.stringify(runs)}`);
  test.info().annotations.push({ type: 'measured', description: `Home at once: ${JSON.stringify(runs)}` });
  expect(
    runs.map((r) => r.loads),
    'items loaded by Home: none, as on main',
  ).toEqual(runs.map(() => 0));
  for (const r of runs) expect(r.layouts, `layouts for Home: ${JSON.stringify(runs)}`).toBeLessThanOrEqual(MAIN_LAYOUTS);
});
