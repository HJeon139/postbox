// The transcript window, W2 (#866): past its ceiling the range unmounts what’s furthest from the view, so scrolling
// through a long room keeps the page bounded; what you read holds still as it does; an item with focus stays on the
// page until focus leaves it; an item’s open details come back when it’s mounted again; and a room that keeps growing
// while you follow it stays bounded too.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const COUNT = 3000;
const CEILING = 240;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
test.beforeAll(async () => {
  app = await startPostbox('window-w2');
  const projectId = Object.values(app.rt.s.projects)[0].id;
  room = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [] }).id;
  seedBigRoom(app.store, room, { count: COUNT });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

async function open(page) {
  await page.addInitScript(() => localStorage.setItem('pb-window', 'on'));
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
}
const mounted = (page) => page.locator('#main > .item').count();

/** Scrolls up a view at a time, `steps` times, letting the range move after each. */
async function scrollUp(page, steps) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -800);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  await settled(page);
}

test('#866 scrolling far up a long room keeps the mounted items at the ceiling', async ({ page }) => {
  await open(page);
  await page.mouse.move(640, 400);
  let most = 0;
  for (let round = 0; round < 6; round++) {
    await scrollUp(page, 15);
    most = Math.max(most, await mounted(page));
  }
  test.info().annotations.push({ type: 'measured', description: `most items mounted while scrolling up: ${most}` });
  expect(most, 'the range unmounts past its ceiling').toBeLessThanOrEqual(CEILING + 40);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'reading');
});

test('#866 what you read holds still while the range unmounts below and above it', async ({ page }) => {
  await open(page);
  await page.mouse.move(640, 400);
  await scrollUp(page, 40);
  const key = await page.evaluate(() => {
    const mid = innerHeight / 2;
    for (const n of document.querySelectorAll('#main > .item')) {
      const r = n.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) return /** @type {HTMLElement} */ (n).dataset.key;
    }
    return null;
  });
  expect(key).toBeTruthy();
  const at = () => page.locator(`#main > .item[data-key="${key}"]`).evaluate((n) => n.getBoundingClientRect().top);
  const before = await at();
  // A few frames for the range to grow and shrink around it, with nothing scrolled.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  await settled(page);
  expect(Math.abs((await at()) - before)).toBeLessThan(1);
});

test('#866 an item with focus stays on the page while you scroll away, and leaves once focus does', async ({ page }) => {
  await open(page);
  const focused = page.locator('#main > .item').last();
  const key = await focused.getAttribute('data-key');
  await focused.focus();
  await page.mouse.move(640, 400);
  for (let round = 0; round < 4; round++) await scrollUp(page, 15);
  const item = page.locator(`#main > .item[data-key="${key}"]`);
  await expect(item, 'the focused item is still mounted').toHaveCount(1);
  expect(await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.dataset.key)).toBe(key);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  await scrollUp(page, 2);
  await expect(item, 'it leaves once nothing holds it').toHaveCount(0);
});

test('#866 a room that grows while you follow it stays bounded, with its newest item in view', async ({ page }) => {
  await open(page);
  const burst = `it_grow_${Date.now()}`;
  for (let i = 0; i < 300; i++)
    app.store.emit('item.add', { threadId: room, item: { id: `${burst}_${i}`, at: Date.now(), kind: 'user', text: `Line ${i} of a burst` } });
  await synced(page, app);
  await settled(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await settled(page);
  await expect(page.locator(`#main > .item[data-key="${burst}_299"]`)).toBeInViewport();
  expect(await mounted(page)).toBeLessThanOrEqual(CEILING + 40);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
});

test('#866 after the window narrows, scrolling down moves what you read by exactly the scroll, as the range unmounts above it', async ({ page }) => {
  await open(page);
  await page.mouse.move(400, 400);
  await scrollUp(page, 60);
  // A narrower window rewraps every item: the heights measured before are stale, and the spacers fall back on estimates.
  await page.setViewportSize({ width: 900, height: 800 });
  await settled(page);
  const key = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#main > .item')];
    const n = items.find((x) => x.getBoundingClientRect().top > 100);
    return /** @type {HTMLElement} */ (n).dataset.key;
  });
  const top = () => page.locator(`#main > .item[data-key="${key}"]`).evaluate((n) => n.getBoundingClientRect().top);
  let was = await top();
  const off = [];
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => scrollBy(0, 150));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const now = await top();
    if (Math.abs(now - was + 150) >= 1) off.push(`step ${i}: moved ${Math.round(now - was)} px`);
    was = now;
  }
  expect(off, 'each 150 px scroll moves the item 150 px, whatever the range did').toEqual([]);
});
