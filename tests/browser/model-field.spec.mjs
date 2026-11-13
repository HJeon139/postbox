// The Model field asks the backend’s own harness for its models when the sheet opens (server/model-lists.mjs), so
// Postbox assumes no list of its own, and whatever the person types goes to the harness as its --model.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('model-field');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A backend whose harness answers each listing with listed, counting the asks. */
function backend(name, listed) {
  const fake = {
    name,
    capabilities: {},
    asked: 0,
    async listModels() {
      fake.asked++;
      return listed;
    },
    deliver: async () => {},
  };
  arrange.withAdapter(app.rt, fake);
  return fake;
}

async function openNewAgent(page) {
  await page.goto(`${app.origin}/#/t/${Object.keys(app.store.state.threads)[0]}`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
  await page.getByRole('menuitem', { name: /From a boilerplate/ }).click();
  return page.getByRole('dialog');
}

const suggested = (sheet) => sheet.locator('datalist option').evaluateAll((options) => options.map((o) => /** @type {HTMLOptionElement} */ (o).value));

test('the sheet suggests what the harness lists, starts on its first model, and a typed model is what the agent runs', async ({ page }) => {
  const claude = backend('claude-code', ['claude-opus-6', 'claude-sonnet-6']);
  backend('kiro-cli', ['auto', 'gpt-5.6']);
  const sheet = await openNewAgent(page);
  const model = sheet.getByLabel('Model', { exact: true });
  await test.step('the harness’s list, asked once, with no model of Postbox’s own', async () => {
    await expect.poll(() => suggested(sheet)).toEqual(['claude-opus-6', 'claude-sonnet-6']);
    // Postbox’s default isn’t one this harness lists, so the sheet starts on the first it does.
    await expect.soft(model).toHaveValue('claude-opus-6');
    await expect.soft(sheet.locator('[data-model-help]')).toHaveCount(0);
    expect.soft(claude.asked).toBe(1);
  });
  await test.step('switching backend asks the new one, and a model typed after that, listed or not, is what the persona runs', async () => {
    await sheet.getByLabel('Backend', { exact: true }).selectOption('kiro-cli');
    await expect.poll(() => suggested(sheet)).toEqual(['auto', 'gpt-5.6']);
    await expect.soft(model).toHaveValue('auto');
    await model.fill('my-gateway/claude-custom');
    await sheet.getByLabel('Name', { exact: true }).fill('custom-model');
    await sheet.getByRole('button', { name: 'Create agent', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => arrange.persona(app.rt, 'custom-model')?.model).toBe('my-gateway/claude-custom');
    expect.soft(arrange.persona(app.rt, 'custom-model')?.backend).toBe('kiro-cli');
  });
});

test('when the harness can’t list its models, the field says so and still takes the model you type', async ({ page }) => {
  backend('claude-code', []);
  const sheet = await openNewAgent(page);
  const help = sheet.locator('[data-model-help]');
  await expect(help).toHaveText(/Claude Code didn’t list its models/);
  await expect.soft(sheet.getByLabel('Model', { exact: true })).toHaveAccessibleDescription(/didn’t list its models/);
  await sheet.getByLabel('Model', { exact: true }).fill('claude-typed-1');
  await sheet.getByLabel('Name', { exact: true }).fill('typed-model');
  await sheet.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(() => arrange.persona(app.rt, 'typed-model')?.model).toBe('claude-typed-1');
});
