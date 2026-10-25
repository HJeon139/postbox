import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('gpt-boilerplate');
  app.rt.adapters.register({ name: 'codex', capabilities: { models: ['gpt-example'] }, deliver: async () => {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the GPT boilerplate selects Codex and fills in editable assistant instructions', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${Object.keys(app.store.state.threads)[0]}`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
  await page.getByRole('menuitem', { name: /From a boilerplate/ }).click();
  await page.getByRole('radio', { name: 'GPT', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'GPT', exact: true })).toBeChecked();
  await expect(page.getByLabel('Runs on', { exact: true })).toHaveValue('codex');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-example');
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(/^# GPT\n/);
  await page.getByLabel('Instructions', { exact: true }).fill('Help me review code.');
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue('Help me review code.');
});
