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
    await expect(boilerplates).toContainText('GPT');
    await expect(boilerplates).toContainText('Indexer');
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
    await expect.poll(() => app.rt.personaByHandle(handle)?.backend).toBe('codex');
    if (models.length) expect(app.rt.personaByHandle(handle)?.model).toBe(models[0]);
    expect(app.rt.personaByHandle(handle)?.instructions).toBe('Help me review code.');
    if (!models.length) {
      const session = Object.values(app.store.state.sessions).find((session) => session.handle === handle);
      const row = page.locator(`#agent-row-${session.id}`);
      await expect(row).toContainText('Codex’s default');
      await expect(row).not.toContainText('Opus');
      await row.click();
      const defaultChoice = page.getByRole('radio', { name: 'Codex’s default', exact: true });
      await expect(defaultChoice).toBeChecked();
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`/api/sessions/${session.id}/run`)),
        defaultChoice.click(),
      ]);
      expect(response.status()).toBe(200);
      await page.keyboard.press('Escape');
      app.rt.updateSession(session.id, { lastModel: 'gpt-answered' });
      await synced(page, app);
      await expect(row).toContainText('gpt-answered');
      await expect(row).not.toContainText('not ');
    }
  });
}

test('Codex labels an inherited Sonnet setting as its default when no catalog offers it', async ({ page }) => {
  app.rt.adapters.register({ name: 'codex', capabilities: { models: [] }, deliver: async () => {} });
  const persona = app.rt.createPersona({ handle: 'inherited-sonnet', backend: 'codex', model: 'claude-sonnet-5-5' });
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: 'Inherited model', personaIds: [persona.id] });
  const session = app.rt.sessionsIn(thread.id)[0];
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const row = page.locator(`#agent-row-${session.id}`);
  await expect(row).toContainText('Codex’s default');
  await expect(row).not.toContainText('Sonnet');
  await row.click();
  await expect(page.getByRole('radio', { name: 'Codex’s default', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  app.rt.updateSession(session.id, { lastModel: 'gpt-answered' });
  await synced(page, app);
  await expect(row).toContainText('gpt-answered');
  await expect(row).not.toContainText('not ');
});
