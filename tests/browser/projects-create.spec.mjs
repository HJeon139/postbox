// Creating a project in Settings › Projects (#547): its folder bounds the file picker and is where its agents start,
// so an empty or relative Root folder, or one with a .. part, is refused with a toast that says to write the full
// path, and no project is made in the folder Postbox was started from. A full path to a folder that exists still
// makes one, kept by its real path.

import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('projects-create');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const folders = () => Object.values(app.store.state.projects).map((p) => p.folder);

/** The toast that says the project wasn’t made, with exactly the server’s message as its text. */
async function refusedWith(page, text) {
  const toast = page.locator('.toast', { hasText: 'Couldn’t create the project' }).filter({ hasText: text });
  await expect.soft(toast.locator('.t-body b')).toHaveText('Couldn’t create the project');
  await expect.soft(toast.locator('.t-body span.small')).toHaveText(text);
}

test('Create project refuses an empty or relative folder, and makes one at a full path', async ({ page }) => {
  allowPageError(page, /status of 422/, { times: 3 });
  await page.goto(app.origin);
  await synced(page, app);
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Projects' }).click();
  const create = settings.getByRole('button', { name: 'Create project' });
  const before = folders();

  await test.step('empty name and folder: refused, and nothing is made in the server’s folder', async () => {
    await create.click();
    await refusedWith(page, 'Write the folder’s full path.');
    await expect.soft(page.locator('.toast', { hasText: /^Created/ })).toHaveCount(0);
    expect.soft(folders()).toEqual(before);
  });

  await test.step('a relative folder: refused, not resolved against the server’s folder', async () => {
    await settings.getByLabel('Name', { exact: true }).fill('Relative');
    await settings.getByLabel('Root folder', { exact: true }).fill('server');
    await create.click();
    await refusedWith(page, 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.');
    expect.soft(folders()).toEqual(before);
  });

  await test.step('a full path with a .. part: refused, not normalized', async () => {
    await settings.getByLabel('Root folder', { exact: true }).fill(`${app.root}/../..`);
    await create.click();
    await refusedWith(page, 'A folder’s path can’t have an empty, . or .. part, such as //, /./ or /../. Write the folder’s full path without them.');
    expect.soft(folders()).toEqual(before);
  });

  await test.step('a full path to a folder that exists: made', async () => {
    const folder = join(app.root, 'mine');
    await mkdir(folder);
    await settings.getByLabel('Name', { exact: true }).fill('Mine');
    await settings.getByLabel('Root folder', { exact: true }).fill(folder);
    await create.click();
    await expect.soft(page.locator('.toast', { hasText: 'Created Mine' })).toBeVisible();
    await expect.poll(folders).toEqual([...before, await realpath(folder)]);
  });
});
