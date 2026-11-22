// #550: New room’s “Pick at least two agents for a room.” stayed under the chips after two or more were picked, until
// the room was started. The error now goes as soon as the agents picked are enough, and comes back on Start if not.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('new-room-error');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#550 New room’s “pick at least two” goes once two agents are picked, by keyboard, and moves nothing', async ({ page }) => {
  await page.goto(`${app.origin}/#/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'New room', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  const error = dialog.getByRole('alert');
  const chips = dialog.locator('.chips button');
  const start = dialog.locator('.d-foot .btn.send');
  /**
   * How high the second chip and Start sit: a notice never moves a button under the pointer (AGENTS.md). Across, a picked
   * chip and Start’s longer label move them, as the person’s own pick does, not the message.
   */
  const where = async () => [await chips.nth(1).boundingBox(), await start.boundingBox()].map((b) => b && Math.round(b.y));
  const still = await where();
  await start.click();
  await expect(error).toHaveText('Pick at least two agents for a room.');
  expect(await where(), 'the message moves nothing as it appears').toEqual(still);

  await chips.nth(0).focus();
  await page.keyboard.press('Enter');
  await expect(error, 'one agent is still too few').toHaveText('Pick at least two agents for a room.');
  await chips.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Start a room with 2 agents' })).toBeVisible();
  await expect(error, 'two are enough').toHaveCount(0);
  expect(await where(), 'nor as it goes').toEqual(still);
  await expect(chips.nth(1), 'focus stays on the chip').toBeFocused();

  // Back to one: nothing is said until Start, which says it again.
  await page.keyboard.press('Enter');
  await expect(error).toHaveCount(0);
  await start.click();
  await expect(error).toHaveText('Pick at least two agents for a room.');
});

test('#550 a failed Start’s error stays when a chip changes: only “pick at least two” goes', async ({ page }) => {
  allowPageError(page, /status of 400/);
  await page.goto(`${app.origin}/#/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'New room', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  const chips = dialog.locator('.chips button');
  await chips.nth(0).click();
  await chips.nth(1).click();
  // The server refuses this Start, as it would a project removed meanwhile.
  await page.route('**/api/threads', (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'That project is gone.' }) }),
  );
  await dialog.locator('.d-foot .btn.send').click();
  await expect(dialog.getByRole('alert')).toHaveText('That project is gone.');
  await chips.nth(2).click();
  await expect(dialog.getByRole('alert'), 'the server’s error stays').toHaveText('That project is gone.');
});
