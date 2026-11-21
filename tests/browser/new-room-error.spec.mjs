// #550: New room’s “Pick at least two agents for a room.” stayed under the chips after two or more were picked, until
// the room was started. The error now goes as soon as the agents picked are enough, and comes back on Start if not.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('new-room-error');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#550 New room’s “pick at least two” goes once two agents are picked, by keyboard', async ({ page }) => {
  const projectId = Object.values(app.store.state.projects)[0].id;
  await page.goto(`${app.origin}/#/`);
  await synced(page, app);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openNewThread(id, { room: true })), projectId);
  const dialog = page.getByRole('dialog', { name: 'New room' });
  const error = dialog.getByRole('alert');
  const chips = dialog.locator('.chips button');
  await dialog.getByRole('button', { name: 'Start conversation' }).click();
  await expect(error).toHaveText('Pick at least two agents for a room.');

  await chips.nth(0).focus();
  await page.keyboard.press('Enter');
  await expect(error, 'one agent is still too few').toHaveText('Pick at least two agents for a room.');
  await chips.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Start a room with 2 agents' })).toBeVisible();
  await expect(error, 'two are enough').toHaveCount(0);
  await expect(chips.nth(1), 'focus stays on the chip').toBeFocused();

  // Back to one: nothing is said until Start, which says it again.
  await page.keyboard.press('Enter');
  await expect(error).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Start conversation' }).click();
  await expect(error).toHaveText('Pick at least two agents for a room.');
});
