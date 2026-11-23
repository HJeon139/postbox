// #119: Settings › Projects deletes a project after one confirm that says what goes and what stays. Its conversations go
// with it, as deleting each would, and its folder on this computer stays. While one project is left its Delete is off,
// still takes focus, and says why.

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { deleteProject } from '../../server/project-delete.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('project-delete');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 800 } });

/** Settings › Projects, open. */
async function projectsTab(page) {
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Projects' }).click();
  return settings;
}
const rowOf = (settings, name) => settings.locator('li.project-row', { hasText: name });

test('#119 Delete project… asks once, deletes its conversations, keeps its folder, and leaves the page it was on', async ({ page }) => {
  const { rt } = app;
  // A long folder path, which the confirm’s head wraps rather than runs past.
  const root = await mkdtemp(join(tmpdir(), 'pb-doomed-'));
  const folder = join(root, 'AFolderNameWithNoBreaksLongEnoughToRunPastTheConfirmHeadIfNothingWrapsItAtAll'.repeat(2));
  await mkdir(folder, { recursive: true });
  rt.store.emit('project', { id: 'pr_doomed', name: 'Doomed', folder });
  const t = rt.createThread({ projectId: 'pr_doomed', title: 'Goes with it', personaIds: [arrange.persona(rt, 'librarian').id] });
  // The page behind Settings shows the project’s conversations, which nothing else redraws when the project goes.
  await page.goto(`${app.origin}/#/p/pr_doomed/threads`);
  await synced(page, app);
  const settings = await projectsTab(page);
  const button = rowOf(settings, 'Doomed').getByRole('button', { name: 'Delete project…' });
  await button.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Delete the project “Doomed”?' });
  await expect(confirm).toContainText('1 conversation, as deleting each would');
  await expect(confirm).toContainText(`Files in ${folder}`);
  // Its head wraps a long folder path rather than running past the dialog.
  const head = confirm.locator('.d-head');
  expect(await head.evaluate((el) => el.scrollWidth <= el.clientWidth), 'the head fits').toBe(true);
  // It opens on Cancel, so an Enter at once deletes nothing, and focus is back on the button.
  await expect(confirm.getByRole('button', { name: 'Cancel' }), 'Cancel focused first').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(button, 'focus back on Delete project… after Cancel').toBeFocused();
  expect(rt.store.state.projects.pr_doomed).toBeTruthy();
  // Escape closes the confirm alone; Settings stays open.
  await page.keyboard.press('Enter');
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(settings, 'Settings stays open').toBeVisible();
  // A double click on Delete project sends one delete, not a second that would report a failure after it.
  const deletes = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && r.url().includes('/api/projects/')) deletes.push(r.url());
  });
  await button.click();
  await page.getByRole('alertdialog', { name: 'Delete the project “Doomed”?' }).getByRole('button', { name: 'Delete project' }).dblclick();
  await expect(rowOf(settings, 'Doomed'), 'its row goes').toHaveCount(0);
  await expect(page.locator('#live'), 'announced').toHaveText('Deleted the project “Doomed”');
  expect(deletes, 'one DELETE for a double click').toHaveLength(1);
  await expect(page.locator('.toast', { hasText: 'Couldn’t delete the project' }), 'and no failure reported').toHaveCount(0);
  // Focus stays in Settings, where the person is, not on the page behind it.
  expect(await settings.evaluate((el) => el.contains(document.activeElement)), 'focus in Settings').toBe(true);
  expect(rt.store.state.projects.pr_doomed, 'the project goes').toBeUndefined();
  expect(rt.store.state.threads[t.id], 'its conversation goes').toBeUndefined();
  expect((await stat(folder)).isDirectory(), 'its folder stays').toBe(true);
  await rm(root, { recursive: true, force: true });
  // The page under Settings was showing that project, so it leaves it.
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('pr_doomed');
});

test('#119 with one project left, Delete project… is off, takes focus, says why, and does nothing', async ({ page }) => {
  const { rt } = app;
  for (const id of Object.keys(rt.store.state.projects).slice(1)) deleteProject(rt, id);
  await page.goto(app.origin);
  await synced(page, app);
  const settings = await projectsTab(page);
  const button = settings.getByRole('button', { name: 'Delete project…' });
  await expect(button).toHaveCount(1);
  const why = 'This is the only project, and Postbox opens on one. Add another project, then delete this one.';
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  // And looks off, as a disabled button does.
  await expect(button).toHaveCSS('opacity', '0.5');
  await expect(button).toHaveAttribute('aria-description', why);
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
