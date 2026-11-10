// Short-lived notices share one top-right region, bounded, with announcements intact (#444).

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
