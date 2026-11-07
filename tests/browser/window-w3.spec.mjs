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
test.beforeAll(async () => {
  app = await startPostbox('window-w3');
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
