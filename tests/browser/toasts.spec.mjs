// Short-lived notices share one top-right region, with Undo and announcements intact (#444).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

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
  test(`#444 at ${width} px, ordinary and delete notices share one region and Undo still works`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/`);
    await synced(page, app);
    await page.keyboard.press('Control+j');
    await expect(page.locator('#toasts .toast', { hasText: 'Nothing needs you right now' })).toBeVisible();
    await page.evaluate(async () => {
      const { undoToast } = await import('/app/js/ui.mjs');
      undoToast({ text: 'Deleted “Draft”', until: Date.now() + 10_000, onUndo: () => (window.undoCalled = true) });
    });

    const region = page.getByRole('region', { name: 'Notifications' });
    await expect(region.locator('.toast')).toHaveCount(2);
    await expect(region.locator('.toast', { hasText: 'Deleted “Draft”' })).toBeVisible();
    await expect(page.locator('#toasts-bottom')).toHaveCount(0);
    await region.getByRole('button', { name: /^Undo/ }).click();
    await expect.poll(() => page.evaluate(() => window.undoCalled)).toBe(true);
  });
