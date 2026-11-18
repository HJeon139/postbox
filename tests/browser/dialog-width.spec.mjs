// Every centered dialog opens at one width (#1497): Settings, a sheet like New agent, and the palette, which had 640,
// 480 and 560 px. 960 px where the window has room, else the window less its gutters, which on a phone are the input
// card’s, so a dialog is the card’s width there.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('dialog-width');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Opens a conversation at the given width, and returns its input card’s width. */
async function room(page, width) {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: `Width ${width}`, personaIds: [arrange.persona(rt, 'librarian').id] });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const card = page.locator('.main > .composer .composer-box');
  await expect(card).toBeVisible();
  return (await card.boundingBox())?.width ?? 0;
}

/** Each dialog, as the person opens it, and closed again. */
const DIALOGS = [
  ['Settings', async (page) => page.getByRole('button', { name: 'Settings', exact: true }).click(), (page) => page.getByRole('dialog', { name: 'Settings' })],
  [
    'New agent',
    async (page) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Personas' }).click();
      await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'New agent' }).click();
    },
    (page) => page.getByRole('dialog', { name: 'New agent' }),
  ],
  ['the palette', async (page) => page.keyboard.press('ControlOrMeta+k'), (page) => page.locator('.dialog.palette')],
];

for (const [width, expected, says] of [
  [1920, () => 960, '960 px, where the window has room'],
  [1280, () => 960, '960 px, where the window has room'],
  [1024, () => 960, '960 px, where the window has room'],
  [768, () => 768 - 32, 'the window less its 16 px gutters'],
  [375, (/** @type {number} */ card) => card, 'the input card’s width, on a phone'],
  [320, (/** @type {number} */ card) => card, 'the input card’s width, on a phone'],
]) {
  test(`#1497 every dialog opens at one width, at ${width} px: ${says}`, async ({ page }) => {
    const card = await room(page, width);
    for (const [name, open, dialog] of DIALOGS) {
      await open(page);
      const d = dialog(page);
      await expect(d).toBeVisible();
      const w = (await d.boundingBox())?.width ?? 0;
      expect.soft(Math.abs(w - expected(card)), `${name} is ${w} px wide`).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(page.locator('.dialog')).toHaveCount(0);
    }
  });
}
