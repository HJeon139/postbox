// A fresh install’s first step, and a new room from the main menu (#1735): with no project yet, “New project” opens the
// form that makes one, not an empty list; and Rooms’ + makes the room in the project that’s open, not the first one.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let fresh;
/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let demo;
test.beforeAll(async () => {
  fresh = await startPostbox('first-project', { demo: false });
  demo = await startPostbox('room-in-open-project');
});
test.afterAll(async () => {
  await fresh?.stop();
  await demo?.stop();
});
failOnPageErrors(test);

test('with no project yet, New project opens on the form, with focus in its name', async ({ page }) => {
  expect(Object.keys(fresh.rt.s.projects)).toEqual([]);
  await page.goto(`${fresh.origin}/`);
  await synced(page, fresh);
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Create project' })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText('No projects yet.')).toHaveCount(0);
});

test('Rooms’ + makes the room in the project that’s open', async ({ page }) => {
  const projects = Object.values(demo.rt.s.projects);
  expect(projects.length).toBeGreaterThan(1);
  // Open a conversation of the last project, so “the first project” would be the wrong one.
  const last = projects.at(-1);
  const thread = Object.values(demo.rt.s.threads).find((t) => t.projectId === last.id && t.kind !== 'side' && t.kind !== 'topic');
  await page.goto(`${demo.origin}/#/t/${thread.id}`);
  await synced(page, demo);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Rooms' }).click();
  await settled(page);
  await dialog.getByRole('button', { name: 'New room', exact: true }).click();
  const sheet = page.getByRole('dialog').last();
  await expect(sheet).toContainText(last.name);
  for (const other of projects.slice(0, -1)) await expect(sheet).not.toContainText(`in ${other.name}`);
});
