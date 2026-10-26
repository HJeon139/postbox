// The Gemini boilerplate in the new-agent sheet: picking it selects the Antigravity CLI backend, its first reported
// Gemini model (or gemini-3.8-flash-high when none was reported), its prompt and its tools; picking a generic
// boilerplate restores the default backend and model; creating the agent stores the Gemini persona.

import { expect, test } from '@playwright/test';
import { AGY_CAPABILITIES } from '../../server/adapters/antigravity-cli.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('gemini-bp');
  app.rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
  app.rt.adapters.register({
    name: 'antigravity-cli',
    capabilities: { ...AGY_CAPABILITIES, models: ['claude-sonnet-4-6', 'gemini-2.5-pro'] },
    deliver: async () => {},
  });
});

test.afterAll(async () => {
  await app?.stop();
});

failOnPageErrors(test);

test('the Gemini boilerplate presets the Antigravity CLI, its first Gemini model and its prompt in New agent', async ({ page }) => {
  const threadId = Object.keys(app.store.state.threads)[0];
  await page.goto(`${app.origin}/#/t/${threadId}`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
  await page.getByRole('menuitem', { name: /From a boilerplate/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await expect(dialog).toBeVisible();
  const bps = dialog.getByRole('radiogroup', { name: 'Boilerplate' });
  await expect.soft(bps.getByRole('radio', { name: 'Gemini' }), 'Gemini is offered in the boilerplate chips').toBeVisible();
  await expect.soft(dialog.getByLabel('Backend'), 'starts on the default backend').toHaveValue('claude-code');
  await expect.soft(dialog.getByLabel('Model'), 'starts on Claude’s default model').toHaveValue('claude-opus-5-5');
  await test.step('picking Gemini switches Runs on, Model, What it does and Instructions', async () => {
    await bps.getByRole('radio', { name: 'Gemini' }).click();
    await expect.soft(bps.getByRole('radio', { name: 'Gemini' })).toHaveAttribute('aria-checked', 'true');
    await expect.soft(dialog.getByLabel('Backend')).toHaveValue('antigravity-cli');
    await expect.soft(dialog.getByLabel('Model')).toHaveValue('gemini-2.5-pro');
    await expect.soft(dialog.getByLabel('What it does')).toHaveValue(/second opinion on Gemini/);
    await expect.soft(dialog.getByLabel('Instructions')).toHaveValue(/^# Gemini\n/);
    await expect.soft(dialog).toContainText('Uses your Antigravity setup');
  });
  await test.step('switching Runs on to Claude Code by hand or picking a generic boilerplate resets Model and Effort', async () => {
    await dialog.getByLabel('Model').fill('gemini-3.8-flash-high');
    await dialog.getByLabel('Model').dispatchEvent('change');
    await expect.soft(dialog.getByLabel('Effort')).toHaveValue('high');
    await dialog.getByLabel('Backend').selectOption('claude-code');
    await expect.soft(dialog.getByLabel('Model')).toHaveValue('claude-opus-5-5');
    await expect.soft(dialog.getByLabel('Effort')).toHaveValue('medium');
    await bps.getByRole('radio', { name: 'Gemini' }).click();
    await bps.getByRole('radio', { name: 'Critic' }).click();
    await expect.soft(dialog.getByLabel('Backend')).toHaveValue('claude-code');
    await expect.soft(dialog.getByLabel('Model')).toHaveValue('claude-opus-5-5');
    await expect.soft(dialog.getByLabel('Instructions')).toHaveValue(/^# Critic\n/);
  });
  await test.step('creating an agent from the Gemini boilerplate saves the Antigravity persona', async () => {
    const handle = `gem-${Math.random().toString(36).slice(2, 8)}`;
    await bps.getByRole('radio', { name: 'Gemini' }).click();
    await dialog.getByLabel('Name').fill(handle);
    await dialog.getByRole('button', { name: 'Create agent' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => app.rt.personaByHandle(handle)?.backend).toBe('antigravity-cli');
    const created = app.rt.personaByHandle(handle);
    expect.soft(created?.model).toBe('gemini-2.5-pro');
    expect.soft(created?.tools).toEqual(['shell', 'web.fetch']);
    expect.soft(created?.instructions).toMatch(/^# Gemini\n/);
  });
});

test('without the Antigravity CLI, the Gemini boilerplate chip is disabled with its reason', async ({ page }) => {
  const threadId = Object.keys(app.store.state.threads)[0];
  app.rt.adapters.adapters.delete('antigravity-cli');
  try {
    await page.goto(`${app.origin}/#/t/${threadId}`);
    await synced(page, app);
    await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
    await page.getByRole('menuitem', { name: /From a boilerplate/ }).click();
    const dlg = page.getByRole('dialog', { name: 'New agent' });
    const chip = dlg.getByRole('radiogroup', { name: 'Boilerplate' }).getByRole('radio', { name: 'Gemini (Antigravity CLI not on this computer)' });
    await expect.soft(chip).toBeDisabled();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    app.rt.adapters.register({
      name: 'antigravity-cli',
      capabilities: { ...AGY_CAPABILITIES, models: ['claude-sonnet-4-6', 'gemini-2.5-pro'] },
      deliver: async () => {},
    });
  }
});
