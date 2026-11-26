// Short-lived notices share one top-right region, bounded, with announcements intact (#444).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('toasts');
  app.store.emit('project', { id: 'p_toasts', name: 'Notices', folder: app.root });
  const persona = app.rt.createPersona({ handle: 'noticer', backend: 'mock', permissionMode: 'auto', tools: [] });
  app.rt.createThread({ projectId: 'p_toasts', title: 'Notices', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const width of [375, 1280])
  test(`#444 at ${width} px, notices share one region, at most three, and a new one is never the one pushed out`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/`);
    await synced(page, app);
    await page.keyboard.press('Control+j');
    const region = page.getByRole('region', { name: 'Notifications' });
    await expect(region.locator('.toast', { hasText: 'Nothing needs you right now' })).toBeVisible();
    await expect(page.locator('#toasts-bottom')).toHaveCount(0);
    await page.evaluate(async () => {
      const { toast } = await import('/app/js/ui.mjs');
      for (let n = 1; n <= 3; n++) toast({ title: `@agent${n} needs you`, level: 'blocking', timeout: 0 });
      toast({ title: 'Your message didn’t send', level: 'blocking', timeout: 0 });
    });
    await expect(region.getByRole('alert').filter({ hasText: 'Your message didn’t send' }), 'the new alert shows').toBeVisible();
    await expect(region.locator('.toast')).toHaveCount(3);
    await expect(region.locator('.toast', { hasText: '@agent1 needs you' }), 'the oldest made room').toHaveCount(0);
  });

test('over a sheet, each notice reaches assistive technology as it comes, a hidden one takes no focus, and Dismiss stays under the pointer', async ({
  page,
}) => {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  const region = page.getByRole('region', { name: 'Notifications' });
  const raise = (/** @type {{ title: string, text?: string, level?: string }} */ notice) =>
    page.evaluate(async (n) => (await import('/app/js/ui.mjs')).toast(n), notice);
  // One at a time: each is in the accessibility tree when it is added, alone, and the one before it has left the tree.
  await raise({ title: 'Added host-1.example.com' });
  await expect(region.getByRole('status')).toHaveText(/Added host-1/);
  await raise({ title: 'Couldn’t save the room', text: 'A room keeps at least one agent, and this would leave it with none. '.repeat(3), level: 'blocking' });
  await expect(region.getByRole('alert')).toHaveText(/Couldn’t save the room/);
  await expect(region.getByRole('status')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(2);
  const hiddenTakesFocus = await page.locator('.toast:not(:visible) button').evaluate((el) => {
    /** @type {HTMLElement} */ (el).focus();
    return document.activeElement === el;
  });
  expect(hiddenTakesFocus, 'a hidden notice’s button takes focus').toBe(false);
  // Under the pointer the notice shows whole, and its Dismiss is still under the pointer once it has grown.
  const shown = page.locator('.toast:visible');
  const height = async () => /** @type {{ height: number }} */ (await shown.boundingBox()).height;
  const dismiss = shown.getByRole('button', { name: 'Dismiss' });
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await dismiss.boundingBox());
  const at = [box.x + box.width / 2, box.y + box.height / 2];
  const cut = await height();
  await page.mouse.move(at[0], at[1]);
  await settled(page);
  expect(await height(), 'whole under the pointer').toBeGreaterThan(cut);
  expect(await dismiss.evaluate((el, [x, y]) => el.contains(document.elementFromPoint(x, y)), at), 'Dismiss is still under the pointer').toBe(true);
});
