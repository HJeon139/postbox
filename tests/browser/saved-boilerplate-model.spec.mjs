// A boilerplate the person saved starts New agent on its own model, listed or not (#1305): saved from New agent with
// a model Codex doesn’t list, it comes back with that model, where Postbox’s own fall back to one the backend lists.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('saved-boilerplate-model');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

async function openNewAgent(page) {
  await page.goto(`${app.origin}/#/t/${Object.keys(app.store.state.threads)[0]}`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
  await page.getByRole('menuitem', { name: /From a boilerplate/ }).click();
  return page.getByRole('dialog', { name: 'New agent' });
}

test('a boilerplate saved with a model Codex doesn’t list starts on that model again', async ({ page }) => {
  const models = ['gpt-6.1-sol', 'auto'];
  arrange.withAdapter(app.rt, { name: 'codex', capabilities: { models }, listModels: async () => models, deliver: async () => {} });
  let sheet = await openNewAgent(page);
  await test.step('save one on Codex, with a model of its own', async () => {
    await sheet.getByLabel('Backend', { exact: true }).selectOption('codex');
    await sheet.getByLabel('Model', { exact: true }).fill('my-gateway/gpt-custom');
    await sheet.getByLabel('Name', { exact: true }).fill('gateway');
    await sheet.getByRole('checkbox', { name: 'Save as a boilerplate' }).click();
    await sheet.getByRole('button', { name: 'Create agent', exact: true }).click();
    await expect(sheet).toBeHidden();
  });
  await test.step('start from it: its model, not one Codex lists', async () => {
    sheet = await openNewAgent(page);
    await sheet.getByRole('radiogroup', { name: 'Boilerplate' }).getByRole('radio', { name: '@gateway' }).click();
    await expect.soft(sheet.getByLabel('Backend', { exact: true })).toHaveValue('codex');
    await expect(sheet.getByLabel('Model', { exact: true })).toHaveValue('my-gateway/gpt-custom');
  });
});
