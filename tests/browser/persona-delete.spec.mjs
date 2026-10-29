// Deleting a persona from its sheet (#208): Delete… asks first, saying what goes and what stays; the Undo toast brings
// it back; once the window has passed it’s gone from Settings › Personas. The window’s end is run directly
// (purgePersona), rather than waited for, as tests/runtime.test.mjs does for a session.

import { expect, test } from '@playwright/test';
import { purgePersona } from '../../server/persona-delete.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('persona-delete');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A persona of its own in a conversation, with its sheet open. */
async function sheet(page, handle) {
  const { rt, store } = app;
  const p = rt.createPersona({ handle, description: 'Checks deleting' });
  rt.createThread({ projectId: Object.keys(store.state.projects)[0], title: `With ${handle}`, personaIds: [p.id] });
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.evaluate((pid) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', pid)), p.id);
  return p;
}

test('Delete… asks first, and Undo keeps the agent and its session', async ({ page }) => {
  const p = await sheet(page, 'gamma');
  await page.getByRole('button', { name: 'Delete…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Delete @gamma?' });
  await expect(ask).toContainText('What it remembered: its own memory, in every project');
  await expect(ask).toContainText('Other agents, and their memory');
  await ask.getByRole('button', { name: 'Delete @gamma' }).click();
  const toast = page.locator('#toasts-bottom .toast', { hasText: 'Deleted @gamma' });
  await expect(toast).toBeVisible();
  await expect.poll(() => Boolean(app.store.state.personas[p.id]?.deleting)).toBe(true);
  await toast.getByRole('button', { name: /Undo/ }).click();
  await expect.poll(() => app.store.state.personas[p.id]?.deleting ?? null).toBe(null);
  const own = Object.values(app.store.state.sessions).filter((se) => se.personaId === p.id);
  expect(own.length).toBe(1);
  expect(own[0].deleting).toBeFalsy();
});

test('once the window has passed, the agent is gone from Settings › Personas', async ({ page }) => {
  const p = await sheet(page, 'delta');
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('alertdialog', { name: 'Delete @delta?' }).getByRole('button', { name: 'Delete @delta' }).click();
  await expect(page.locator('#toasts-bottom .toast', { hasText: 'Deleted @delta' })).toBeVisible();
  // The sheet goes back to its list, which leaves it out while it’s being deleted, and after.
  const list = page.locator('.dialog .list-rows');
  await expect(list).toContainText('@librarian');
  await expect(list).not.toContainText('@delta');
  await purgePersona(app.rt, p.id);
  expect(app.store.state.personas[p.id]).toBeUndefined();
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas')));
  await expect(page.locator('.dialog .list-rows').last()).toContainText('@librarian');
  await expect(page.locator('.dialog .list-rows').last()).not.toContainText('@delta');
});
