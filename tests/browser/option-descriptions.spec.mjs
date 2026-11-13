// #838: agents gave a choice’s options a one-line description, and the whole block was refused. An option’s
// description now shows under its label in a choice, which then lays its options out as panels, and after its label
// in a form’s select.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let t;

test.beforeAll(async () => {
  app = await startPostbox('option-descriptions');
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  t = rt.createThread({ projectId: project.id, title: 'Index plan', personaIds: [arrange.persona(rt, 'librarian').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const options = [
    { id: 'keep', label: 'Keep it', description: 'Leaves the index as it is.' },
    { id: 'rebuild', label: 'Rebuild', description: 'Takes about ten minutes.' },
  ];
  tools.show_block({ block: { id: 'which', type: 'choice', version: 1, title: 'The index', fallback: 'Keep or rebuild?', options } });
  tools.show_block({
    block: { id: 'plan', type: 'form', version: 1, title: 'The plan', fallback: 'Pick a plan.', fields: [{ id: 'p', label: 'Plan', kind: 'select', options }] },
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#838 a choice shows each option’s description under its label, and a select after it', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const choice = page.locator('.transcript .block', { hasText: 'The index' });
  const keep = choice.getByRole('radio', { name: /Keep it/ });
  await expect(keep.locator('.chip-desc')).toHaveText('Leaves the index as it is.');
  await expect(choice.locator('.chips')).toHaveClass(/panels/);
  const label = await keep.locator('.chip-text > span').first().boundingBox();
  const desc = await keep.locator('.chip-desc').boundingBox();
  expect(desc && label && desc.y > label.y, 'the description is under the label').toBe(true);
  const select = page.locator('.transcript .block', { hasText: 'The plan' }).locator('select');
  await expect(select.locator('option')).toHaveText(['Choose…', 'Keep it — Leaves the index as it is.', 'Rebuild — Takes about ten minutes.']);
  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'true');
});
