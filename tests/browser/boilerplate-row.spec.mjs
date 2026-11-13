// The New agent sheet on a fresh install, which has no project: its subtitle says so instead of “undefined”.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('boilerplate-row', { demo: false });
});

test.afterAll(async () => {
  await app?.stop();
});

failOnPageErrors(test);

/** Settings, on its Personas tab, on the fresh install’s home page. */
async function personas(page) {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Personas' }).click();
  return settings;
}

test('New agent on a fresh install says no project holds its session yet', async ({ page }) => {
  const settings = await personas(page);
  await settings.getByRole('button', { name: 'New agent' }).click();
  const sheet = page.getByRole('dialog', { name: 'New agent' });
  await expect(sheet).toBeVisible();
  await expect.soft(sheet, 'no project to name').not.toContainText('undefined');
  await expect.soft(sheet).toContainText('Create a project to start a session with it.');
});
