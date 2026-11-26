// #518: an answer settles after the agent has already revised the block. A form’s and a choice’s drafts, like a
// review’s (review-answer-race.spec.mjs), are kept for the newer revision rather than deleted with the settled answer.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { holdAct } from './answer-hold.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('block-answer-race');
  // The agent’s turn takes the answer and ends at once, so the answer is read, and an update can reopen the block.
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#518 what the person types into a form’s newer revision survives the older answer settling and the next revision', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Form', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const form = { id: 'trip', type: 'form', version: 1, fallback: 'Plan the trip', fields: [{ id: 'a', label: 'Where to?', kind: 'text' }] };
  tools.show_block({ block: form });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'trip');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  const { release } = await holdAct(page, t.id, item.id);
  await block.getByRole('textbox', { name: 'Where to?' }).fill('Lisbon');
  await block.getByRole('button', { name: 'Send form' }).click();
  await expect.poll(() => store.item(t.id, item.id).answer?.read).toBe(true);
  const two = { ...form, fields: [...form.fields, { id: 'b', label: 'When?', kind: 'text' }] };
  expect(tools.update_block({ block: two }).ok).toBe(true);
  await block.getByRole('textbox', { name: 'When?' }).fill('May');
  release();
  await page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  // The agent revises once more, which draws the form again from its draft.
  expect(tools.update_block({ block: { ...two, title: 'Plan the trip' } }).ok).toBe(true);
  await expect(block.getByRole('textbox', { name: 'When?' })).toHaveValue('May');
});

test('#518 a choice picked on a newer revision survives the older answer settling and the next revision', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Choice', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const choice = {
    id: 'when',
    type: 'choice',
    version: 1,
    fallback: 'When?',
    multiple: true,
    options: [
      { id: 'mon', label: 'Monday' },
      { id: 'tue', label: 'Tuesday' },
    ],
  };
  tools.show_block({ block: choice });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'when');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  const { release } = await holdAct(page, t.id, item.id);
  await block.getByRole('button', { name: 'Monday' }).click();
  await block.getByRole('button', { name: /^Send/ }).click();
  await expect.poll(() => store.item(t.id, item.id).answer?.read).toBe(true);
  const two = { ...choice, options: [...choice.options, { id: 'wed', label: 'Wednesday' }] };
  expect(tools.update_block({ block: two }).ok).toBe(true);
  await block.getByRole('button', { name: 'Wednesday' }).click();
  release();
  await page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  expect(tools.update_block({ block: { ...two, title: 'When?' } }).ok).toBe(true);
  await expect(block.getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'true');
});
