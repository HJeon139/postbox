// Settings › Personas shows the boilerplates, so a fresh install can find Gemini and GPT without opening New agent
// first: one chip each, in the sheet’s order, opens the New agent sheet with that boilerplate chosen, and focus comes
// back to the chip when the sheet closes. A boilerplate whose backend isn’t here is unavailable, with its reason, as in
// the sheet: this fresh install runs the mock, with an Antigravity CLI stand-in and no Codex. The New agent sheet
// starts on Blank, and on a fresh install, which has no project, its subtitle says so instead of “undefined”.

import { expect, test } from '@playwright/test';
import { AGY_CAPABILITIES } from '../../server/adapters/antigravity-cli.mjs';
import { failOnPageErrors, focusIs, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('boilerplate-row', { demo: false });
  app.rt.adapters.register({ name: 'antigravity-cli', capabilities: { ...AGY_CAPABILITIES, models: ['gemini-2.5-pro'] }, deliver: async () => {} });
});

test.afterAll(async () => {
  await app?.stop();
});

failOnPageErrors(test);

/** Settings, on its Personas tab, on the fresh install’s home page. */
async function personas(page) {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Personas' }).click();
  return settings;
}

test('Settings › Personas lists every boilerplate, and a chip opens New agent with it chosen', async ({ page }) => {
  const settings = await personas(page);
  const row = settings.getByRole('group', { name: 'Start from a boilerplate' });
  await test.step('one chip per boilerplate, in the sheet’s order, with a missing backend’s reason', async () => {
    const names = Object.values(app.store.state.boilerplates).map((b) => (b.backend === 'codex' ? `${b.name} (Codex not on this computer)` : b.name));
    await expect.soft(row.getByRole('button')).toHaveText(names);
    await expect.soft(row.getByRole('button', { name: 'GPT (Codex not on this computer)' })).toBeDisabled();
    await expect.soft(row.getByRole('button', { name: 'Gemini', exact: true })).toBeEnabled();
  });
  await test.step('Gemini, from the keyboard, opens the sheet with Gemini chosen, and focus in it', async () => {
    await row.getByRole('button', { name: 'Gemini', exact: true }).focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'New agent' });
    await expect(sheet).toBeVisible();
    await expect.soft(sheet.getByRole('radiogroup', { name: 'Boilerplate' }).getByRole('radio', { name: 'Gemini' })).toHaveAttribute('aria-checked', 'true');
    await expect.soft(sheet.getByLabel('Backend')).toHaveValue('antigravity-cli');
    await expect.soft(sheet.getByLabel('Instructions')).toHaveValue(/^# Gemini\n/);
    await expect.soft(sheet.getByLabel('Name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
  await test.step('closing the sheet leaves Settings open, with focus back on the chip', async () => {
    await expect.soft(settings).toBeVisible();
    await focusIs(page, 'button: Gemini');
  });
  await test.step('creating the agent closes Settings too', async () => {
    await row.getByRole('button', { name: 'Gemini', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'New agent' });
    // CI repeats the spec on one server, so each run names its own agent.
    const handle = `gem-${Math.random().toString(36).slice(2, 8)}`;
    await sheet.getByLabel('Name').fill(handle);
    await sheet.getByRole('button', { name: 'Create agent' }).click();
    await expect(sheet).toBeHidden();
    await expect.soft(settings).toBeHidden();
    await expect.poll(() => app.rt.personaByHandle(handle)?.backend).toBe('antigravity-cli');
  });
});

test('New agent on a fresh install starts on Blank, and says no project holds its session yet', async ({ page }) => {
  const settings = await personas(page);
  await settings.getByRole('button', { name: 'New agent' }).click();
  const sheet = page.getByRole('dialog', { name: 'New agent' });
  await expect(sheet).toBeVisible();
  await expect.soft(sheet.getByRole('radiogroup', { name: 'Boilerplate' }).getByRole('radio', { name: 'Blank' })).toHaveAttribute('aria-checked', 'true');
  await expect.soft(sheet.getByLabel('Instructions')).toHaveValue('');
  await expect.soft(sheet, 'no project to name').not.toContainText('undefined');
  await expect.soft(sheet).toContainText('Create a project to start a session with it.');
});
