// GPT selection survives agent creation with a reported model or the Codex backend default.
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('gpt-boilerplate');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const models of [['gpt-example'], []]) {
  test(`the GPT boilerplate creates a Codex persona with ${models.length ? 'its reported model' : 'the backend default'}`, async ({ page }) => {
    app.rt.adapters.register({ name: 'codex', capabilities: { models }, deliver: async () => {} });
    await page.goto(`${app.origin}/#/t/${Object.keys(app.store.state.threads)[0]}`);
    await synced(page, app);
    await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
    const boilerplates = page.getByRole('menuitem', { name: /From a boilerplate/ });
    await expect(boilerplates).toContainText('Built-in personas or one you saved');
    await boilerplates.click();
    await page.getByRole('radio', { name: 'GPT', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'GPT', exact: true })).toBeChecked();
    await expect(page.getByLabel('Runs on', { exact: true })).toHaveValue('codex');
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue(models[0] ?? '');
    await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(/^# GPT\n/);
    await page.getByLabel('Instructions', { exact: true }).fill('Help me review code.');
    const handle = models.length ? 'gpt-reported' : 'gpt-default';
    await page.getByLabel('Name', { exact: true }).fill(handle);
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => app.rt.personaByHandle(handle)?.model).toBe(models[0] ?? 'claude-opus-5-5');
    expect(app.rt.personaByHandle(handle)?.backend).toBe('codex');
    expect(app.rt.personaByHandle(handle)?.instructions).toBe('Help me review code.');
  });
}
