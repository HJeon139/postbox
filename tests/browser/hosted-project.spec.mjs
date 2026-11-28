// A project on a hosted Postbox (designs/architecture/hosted.md, “What assumed one computer”, “Project and agent
// folders”): the server has no folder for one, so the form asks for a name alone and says where its agents work, and
// the project is made. The owner couldn’t make one on the test deployment, where the form asked for a path on the
// server. The page is signed in as a load balancer would sign it: every request carries the fixture person’s token.

import { expect, test } from '@playwright/test';
import { NOW, publicPem, SETTINGS, tokenFor } from '../alb-fixture.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('hosted-project', { server: { signIn: { settings: SETTINGS, get: async () => publicPem, now: () => NOW } } });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ extraHTTPHeaders: { 'x-amzn-oidc-data': tokenFor() } });

test('hosted, New project asks for a name alone, says where agents work, and makes the project', async ({ page }) => {
  await page.goto(app.origin);
  await synced(page, app);
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Projects' }).click();
  await settings.getByRole('button', { name: 'New project' }).click();

  await expect(settings.getByLabel('Root folder')).toHaveCount(0);
  await expect(settings.locator('#pj-f')).toHaveCount(0);
  await expect(settings.locator('#pj-f-help')).toHaveText(
    'Agents work on hosts. Set where this project’s agents work on each host in Settings › Hosts; until then, each works in a folder of its own there.',
  );

  await settings.getByLabel('Name').fill('Storefront');
  await settings.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.toast', { hasText: 'Created Storefront' })).toBeVisible();

  const made = Object.values(app.store.state.projects).find((/** @type {any} */ p) => p.name === 'Storefront');
  expect(made, 'the project is in the store').toBeTruthy();
  expect('folder' in /** @type {any} */ (made), 'and names no folder on the server').toBe(false);
  // Back on the list, its row says where its folders are, where a local project’s row shows its path.
  const row = settings.locator('.project-row', { hasText: 'Storefront' });
  await expect(row).toContainText('Folders on its hosts');

  await test.step('its own form shows the same, with no path', async () => {
    await row.click();
    await settings.getByRole('button', { name: 'Edit Storefront' }).click();
    await expect(settings.getByText('Folders on its hosts', { exact: true })).toBeVisible();
    await expect(settings.getByLabel('Repository to push to')).toBeVisible();
  });

  await test.step('its conversations offer no project folder to add a file from', async () => {
    const t = app.rt.createThread({ projectId: /** @type {any} */ (made).id, title: 'Storefront talk' });
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    // The page hears of the conversation before it goes there, or under lag it falls back to another one.
    await synced(page, app);
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    await page.getByRole('button', { name: /^Add a file/ }).click();
    await expect(page.getByRole('menuitem', { name: /^Upload from computer/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /From the project folder/ })).toHaveCount(0);
  });
});
