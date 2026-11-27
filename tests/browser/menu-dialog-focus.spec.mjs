// The permissions panel and the delete confirm, opened from a room’s form in the main menu, left focus on the button
// that opened them, so the first Tab landed on a control behind (UAT of 26 Nov). Every dialog takes focus as it opens,
// keeps Tab inside it, and gives focus back to its opener when it closes.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room;
test.beforeAll(async () => {
  app = await startPostbox('menu-dialog-focus');
  const { rt } = app;
  const personas = ['indexer', 'researcher'].map((handle) => arrange.persona(rt, handle) ?? rt.createPersona({ handle }));
  room = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Index planning', personaIds: personas.map((p) => p.id) });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// Where focus starts: the panel, still reading the agent’s settings as it opens, on its Close; the confirm on Cancel.
for (const [opener, name, start] of [
  ['Permissions…', /permissions$/, 'Close'],
  [/^Delete Index planning/, 'Delete the room “Index planning”?', 'Cancel'],
])
  test(`${String(opener)} from the room’s form takes focus, keeps Tab inside, and gives focus back`, async ({ page }) => {
    await page.goto(`${app.origin}/#/t/${room.id}`);
    await synced(page, app);
    await page.getByRole('button', { name: 'Manage Index planning' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const button = settings.getByRole('button', { name: opener });
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole(typeof name === 'string' ? 'alertdialog' : 'dialog', { name });
    await expect(dialog).toBeVisible();
    const inside = () => dialog.evaluate((d) => d.contains(document.activeElement));
    await expect.poll(inside, { message: 'focus is in the dialog as it opens' }).toBe(true);
    await expect(dialog.getByRole('button', { name: start, exact: true }), `it starts on ${start}`).toBeFocused();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab ${i + 1} stays in the dialog`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button, 'focus back on its opener').toBeFocused();
  });
