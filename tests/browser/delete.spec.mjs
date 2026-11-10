// Delete is just delete (designs/rooms-at-scale.md, “Delete”; #604, #599): one confirm says what goes, and after it
// the conversation, the session or the persona is gone at once. There’s no Undo, and nothing waits on a window.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('delete');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const projectId = () => Object.keys(app.store.state.projects)[0];

/** A persona of its own in a conversation of its own. @param {string} handle */
function withAgent(handle) {
  const p = app.rt.createPersona({ handle, description: 'Checks deleting' });
  const t = app.rt.createThread({ projectId: projectId(), title: `With ${handle}`, personaIds: [p.id] });
  return { p, t, se: app.rt.sessionsIn(t.id)[0] };
}

test('deleting a conversation: the confirm says what goes and that it can’t be undone, and it’s gone at once', async ({ page }) => {
  const { p, t, se } = withAgent('convgone');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.getByRole('button', { name: `Actions for ${t.title}` }).click();
  await page.getByRole('menuitem', { name: /Delete conversation/ }).click();
  const ask = page.getByRole('alertdialog', { name: `Delete the conversation “${t.title}”?` });
  await expect.soft(ask).toContainText('This erases');
  await expect.soft(ask).toContainText('This can’t be undone.');
  await ask.getByRole('button', { name: 'Delete conversation' }).click();
  await expect.soft(page.locator('#toasts').getByRole('button', { name: /Undo/ }), 'no Undo').toHaveCount(0);
  expect.soft(app.store.state.threads[t.id], 'the conversation is gone').toBeUndefined();
  expect.soft(app.store.state.sessions[se.id], 'its session too').toBeUndefined();
  expect.soft(app.store.state.personas[p.id], 'the persona stays').toBeTruthy();
  expect.soft(app.rt.timers.size, 'no timer waits to finish it').toBe(0);
  await expect.soft(page).not.toHaveURL(new RegExp(`#/t/${t.id}`));
});

test('deleting a session from the agent’s quick panel removes it at once after its confirm', async ({ page }) => {
  const { p } = withAgent('sesgone');
  const other = app.rt.createPersona({ handle: 'stays' });
  const room = app.rt.createThread({ projectId: projectId(), title: 'Room for a delete', personaIds: [p.id, other.id] });
  const se = app.rt.sessionsIn(room.id).find((x) => x.personaId === p.id);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await page.locator(`#agent-row-${se.id}`).click();
  await page.locator('.dialog.quick').getByRole('button', { name: 'Delete session…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Delete sesgone’s session?' });
  await expect.soft(ask).toContainText('This can’t be undone.');
  await ask.getByRole('button', { name: 'Delete session' }).click();
  await expect.soft(page.locator(`#agent-row-${se.id}`)).toHaveCount(0);
  expect.soft(app.store.state.sessions[se.id]).toBeUndefined();
  expect.soft(app.store.state.threads[room.id]?.members, 'the room keeps its other agent').toHaveLength(1);
  await expect.soft(page.locator('#toasts').getByRole('button', { name: /Undo/ }), 'no Undo').toHaveCount(0);
});

test('deleting a persona from its sheet takes it and its sessions at once, and the sheet’s list leaves it out', async ({ page }) => {
  const { p, se } = withAgent('gamma');
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.evaluate((pid) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', pid)), p.id);
  await page.getByRole('button', { name: 'Delete…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Delete gamma?' });
  await expect.soft(ask).toContainText('What it remembered: its own memory, in every project');
  await expect.soft(ask).toContainText('Other agents, and their memory');
  await expect.soft(ask).toContainText('This can’t be undone.');
  await ask.getByRole('button', { name: 'Delete gamma' }).click();
  expect.soft(app.store.state.personas[p.id], 'the persona is gone').toBeUndefined();
  expect.soft(app.store.state.sessions[se.id], 'its session too').toBeUndefined();
  const list = page.locator('.dialog .list-rows');
  await expect.soft(list).toContainText('librarian');
  await expect.soft(list).not.toContainText('gamma');
  await expect.soft(page.locator('#toasts').getByRole('button', { name: /Undo/ }), 'no Undo').toHaveCount(0);
});
