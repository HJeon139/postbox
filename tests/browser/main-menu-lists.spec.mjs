// The main menu’s lists (#558, app/js/manage-list.mjs): Rooms and People are managed as every kind is, in a list you
// pick a row in, with one bar under it whose + and − act on the pick, and one form at a time.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('main-menu-lists');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

async function menu(page, tab) {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: tab }).click();
  await settled(page);
  return dialog;
}

test('Rooms: the first row is picked, the arrow keys move the pick, the bar names it, and Enter opens its form', async ({ page }) => {
  const dialog = await menu(page, 'Rooms');
  const rows = dialog.getByRole('listbox', { name: 'Rooms and conversations' }).getByRole('option');
  const titles = Object.values(app.store.state.threads)
    .filter((t) => t.kind !== 'side' && t.kind !== 'topic')
    .map((t) => t.title)
    .sort((a, b) => a.localeCompare(b));
  await expect(rows).toHaveCount(titles.length);
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  // Every control of the list is in view at once: + and −, then what else acts on the pick.
  for (const name of ['New room', `Delete ${titles[0]}…`, `Edit ${titles[0]}`, `Open ${titles[0]}`])
    await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(1)).toBeFocused();
  await expect(dialog.getByRole('button', { name: `Edit ${titles[1]}`, exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Title')).toHaveValue(titles[1]);
  await expect(dialog.getByRole('listbox', { name: `Members of ${titles[1]}` })).toBeVisible();
  for (const name of ['Save', `Delete ${titles[1]}…`]) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  // Back to the list, with the pick kept.
  await dialog.getByRole('button', { name: 'All rooms' }).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('People: + and − are in view and off, saying why, and Edit goes to your own profile', async ({ page }) => {
  const dialog = await menu(page, 'People');
  const rows = dialog.getByRole('listbox', { name: 'People' }).getByRole('option');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('you');
  for (const name of ['Add a person', /^Remove /]) {
    const sign = dialog.getByRole('button', { name });
    await expect(sign).toHaveAttribute('aria-disabled', 'true');
    await expect(sign).toHaveAttribute('aria-description', 'On this computer, you are the account Postbox runs as.');
  }
  await dialog.getByRole('button', { name: 'Edit your profile' }).click();
  await expect(dialog.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByLabel('Name')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save profile' })).toBeInViewport({ ratio: 1 });
});

test('Hosts: the pick’s status shows under the list, − and Edit name it, + shows New host, and an edit pins Save', async ({ page }) => {
  const [first, second] = ['build.example.com', 'gpu.example.com'];
  for (const name of [first, second]) app.rt.addHost({ name });
  const dialog = await menu(page, 'Hosts');
  const rows = dialog.getByRole('listbox', { name: 'Hosts' }).getByRole('option');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await expect(rows.first()).toContainText('Not heard from yet');
  // One host’s card at a time: the pick’s.
  await expect(dialog.getByRole('region', { name: first, exact: true })).toBeVisible();
  await expect(dialog.getByRole('region', { name: second, exact: true })).toHaveCount(0);
  await rows.nth(1).click();
  await expect(dialog.getByRole('region', { name: second, exact: true })).toBeVisible();
  await expect(dialog.getByRole('region', { name: first, exact: true })).toHaveCount(0);
  for (const name of ['Add a host', `Remove ${second}`, `Edit settings for ${second}`])
    await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  // Edit: the settings open in its card, with Save and Cancel pinned under the sheet in the bar’s place.
  await dialog.getByRole('button', { name: `Edit settings for ${second}`, exact: true }).click();
  for (const name of ['Save', 'Cancel']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: 'Add a host', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: `Edit settings for ${second}`, exact: true })).toBeFocused();
  // +: the New host form in the list’s place, and back.
  await dialog.getByRole('button', { name: 'Add a host', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'SSH destination' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Add host', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(rows).toHaveCount(0);
  await dialog.getByRole('button', { name: 'All hosts' }).click();
  await expect(rows.nth(1), 'the pick is kept').toHaveAttribute('aria-selected', 'true');
});
