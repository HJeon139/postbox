// The transcript window, W3 (#866): a jump to an item the window holds off the page mounts the range around it
// first, then scrolls to it and focuses it, as every jump does; and an event for an item off the page shows once it’s
// mounted, drawn from the state.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const COUNT = 3000;
const CEILING = 240;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
// Just over CEILING, so the window holds it, and small enough to mount whole quickly once it doesn’t.
const JUST_OVER = 300;
let small = '';
test.beforeAll(async () => {
  app = await startPostbox('window-w3');
  const projectId = Object.values(app.rt.store.state.projects)[0].id;
  room = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [] }).id;
  seedBigRoom(app.store, room, { count: COUNT });
  small = app.rt.createThread({ projectId, title: `${JUST_OVER} items`, personaIds: [] }).id;
  seedBigRoom(app.store, small, { count: JUST_OVER });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

async function open(page, id = room) {
  await page.addInitScript(() => localStorage.setItem('pb-window', 'on'));
  await page.goto(`${app.origin}/#/t/${id}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
}

/** Jumps to an item as Needs you and ⌃J do (needs-nav.mjs, focusItem), and says whether it got there. */
const jump = (page, id) => page.evaluate((itemId) => import('/app/js/needs-nav.mjs').then((m) => m.focusItem(itemId)), id);

test('#866 a jump to an item far above the mounted range mounts it, scrolls to it and focuses it', async ({ page }) => {
  await open(page);
  const target = app.store.items(room)[40];
  await expect(page.locator(`#main > .item[data-key="${target.id}"]`), 'off the page at first').toHaveCount(0);
  expect(await jump(page, target.id), 'the jump found it').toBe(true);
  const node = page.locator(`#main > .item[data-key="${target.id}"]`);
  await expect(node).toBeInViewport();
  expect(await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.closest('[data-key]')?.getAttribute('data-key'))).toBe(target.id);
  expect(await page.locator('#main > .item').count(), 'still a bounded range').toBeLessThanOrEqual(CEILING + 40);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'reading');
});

test('#866 an item changed while off the page shows the change once a jump mounts it', async ({ page }) => {
  await open(page);
  const target = app.store.items(room).find((it, i) => i > 100 && i < 600 && it.kind === 'agent');
  const text = `Changed while off the page ${Date.now()}`;
  app.store.emit('item.patch', { threadId: room, id: target.id, patch: { text } });
  await synced(page, app);
  await expect(page.locator(`#main > .item[data-key="${target.id}"]`)).toHaveCount(0);
  expect(await jump(page, target.id)).toBe(true);
  await expect(page.locator(`#main > .item[data-key="${target.id}"]`)).toContainText(text);
});

test('#866 after a jump far up, a jump back to the newest item mounts the end again', async ({ page }) => {
  await open(page);
  const items = app.store.items(room);
  expect(await jump(page, items[10].id)).toBe(true);
  await expect(page.locator(`#main > .item[data-key="${items.at(-1).id}"]`)).toHaveCount(0);
  expect(await jump(page, items.at(-1).id)).toBe(true);
  await expect(page.locator(`#main > .item[data-key="${items.at(-1).id}"]`)).toBeInViewport();
});

const anchorOf = (page) => page.locator('#main').getAttribute('data-view-anchor');
const firstKey = (page) => page.locator('#main > .item').first().getAttribute('data-key');

test('#866 a jump far up keeps its target the anchor while the range grows above it', async ({ page }) => {
  await open(page);
  const target = app.store.items(room)[1500];
  expect(await jump(page, target.id)).toBe(true);
  const node = page.locator(`#main > .item[data-key="${target.id}"]`);
  await expect(node).toBeInViewport();
  const first = await firstKey(page);
  const y = await node.evaluate((n) => n.getBoundingClientRect().top);
  // The range mounted around the target fills two and a half views above it at the items’ estimated heights. Items
  // that draw shorter than that, as a run of one-line messages does, bring its top spacer within the margin, and the
  // range grows up while the jump still holds its target.
  await page.evaluate((key) => {
    for (const n of document.querySelectorAll('#main > .item')) {
      if (n.getAttribute('data-key') === key) break;
      /** @type {HTMLElement} */ (n).style.cssText = 'max-height: 8px; overflow: hidden';
    }
  }, target.id);
  await expect.poll(() => firstKey(page), { message: 'the range grew up' }).not.toBe(first);
  await settled(page);
  expect(await anchorOf(page), 'the jump’s target is still the anchor').toBe(target.id);
  const after = await node.evaluate((n) => n.getBoundingClientRect().top);
  expect(Math.abs(after - y), `the target was at ${y} px and is at ${after} px`).toBeLessThan(1);
});

/** The page loads its state again, as on a resync (client.mjs). */
const resync = (page) => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.emit({ type: 'load' })));

test('#866 a resync with the window on rebuilds around where you are reading, not where the room opened', async ({ page }) => {
  await open(page);
  const target = app.store.items(room)[1200];
  expect(await jump(page, target.id)).toBe(true);
  await expect(page.locator(`#main > .item[data-key="${target.id}"]`)).toBeInViewport();
  await settled(page);
  const reading = await anchorOf(page);
  await resync(page);
  await settled(page);
  await expect(page.locator(`#main > .item[data-key="${reading}"]`), 'what you read is mounted again, in view').toBeInViewport();
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'reading');
});

test('#866 the window torn down gives the transcript its skipping back', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'content-visibility, which skipping needs, is checked in Chromium');
  await open(page, small);
  expect(await page.locator('#main > .item').count(), 'the window holds the room').toBeLessThan(JUST_OVER);
  await expect(page.locator('#main'), 'no skipping under the window').not.toHaveClass(/cv-skip/);
  // The flag off, a resync rebuilds the room whole, with no window. The init script sets it again only on a load.
  await page.evaluate(() => localStorage.setItem('pb-window', 'off'));
  await resync(page);
  await expect(page.locator('#main > .item')).toHaveCount(app.store.items(small).length);
  await expect(page.locator('#main')).toHaveClass(/cv-skip/);
});

test('#866 Alt+↑ up the room keeps its target the anchor, in place, while the range grows above it', async ({ page }) => {
  await open(page);
  const focused = () => page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.closest('[data-key]')?.getAttribute('data-key'));
  const first = await firstKey(page);
  // jumpTo(…, 'nearest') (keys.mjs) leaves each target at the view’s top edge, not across its middle, and pins it.
  // Up until the view’s top comes within the margin of the range’s top, and the range grows.
  let grew = false;
  for (let i = 0; i < 80 && !grew; i++) {
    await page.keyboard.press('Alt+ArrowUp');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    grew = (await firstKey(page)) !== first;
  }
  expect(grew, 'the range grew up').toBe(true);
  await settled(page);
  const target = await focused();
  expect(await anchorOf(page), 'the target is the anchor, not the item across the middle').toBe(target);
  // A narrower window rewraps what’s between the target and the middle: only an anchor on the target keeps it in place.
  const node = page.locator(`#main > .item[data-key="${target}"]`);
  const y = await node.evaluate((n) => n.getBoundingClientRect().top);
  await page.setViewportSize({ width: 900, height: 720 });
  await settled(page);
  const after = await node.evaluate((n) => n.getBoundingClientRect().top);
  expect(Math.abs(after - y), `the target was at ${y} px and is at ${after} px`).toBeLessThan(1);
});
