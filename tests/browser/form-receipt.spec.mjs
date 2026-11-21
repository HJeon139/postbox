// #247: a form’s receipt, the line in the person’s voice, kept only the
// first two fields it was sent, so “Channel beta” and “Notify team on” never showed though the agent received them.
// The fields and values are the ones from the issue’s manual UAT of v0.44.7.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('form-receipt');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#247 a form’s receipt lists every field the person sent', async ({ page }) => {
  const { rt } = app;
  const project = Object.values(rt.store.state.projects)[0];
  const thread = rt.createThread({ projectId: project.id, title: 'Release', personaIds: [arrange.persona(rt, 'librarian').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  const fields = [
    { id: 'build', label: 'Build number', kind: 'number' },
    { id: 'date', label: 'Release date', kind: 'date' },
    { id: 'channel', label: 'Channel', kind: 'select', options: [{ id: 'beta', label: 'beta' }] },
    { id: 'notify', label: 'Notify team', kind: 'toggle' },
  ];
  tools.show_block({ block: { id: 'release', type: 'form', version: 1, title: 'Schedule a release', fallback: 'When?', fields } });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const block = page.locator('.transcript .block', { hasText: 'Schedule a release' });
  await block.getByRole('textbox', { name: 'Build number' }).fill('42');
  await block.getByLabel('Release date').fill('2026-10-31');
  await block.getByRole('combobox', { name: 'Channel' }).selectOption('beta');
  await block.getByRole('switch', { name: 'Notify team' }).click();
  await block.getByRole('button', { name: 'Send form' }).click();

  const receipt = 'Sent: Schedule a release · Build number 42 · Release date “2026-10-31” · Channel beta · Notify team on';
  await expect(page.locator('.transcript .voice'), 'the line in your voice').toHaveText(receipt);
});

// From review: the answered form read each field’s value from what was sent, so an unanswered field with an id like
// “constructor” showed Object’s own function in its box.
test('#247 an answered form leaves a field the person didn’t fill empty, whatever its id', async ({ page }) => {
  const { rt } = app;
  const project = Object.values(rt.store.state.projects)[0];
  const thread = rt.createThread({ projectId: project.id, title: 'Volumes', personaIds: [arrange.persona(rt, 'librarian').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  const fields = [
    { id: 'q', label: 'Questions', kind: 'number' },
    { id: 'constructor', label: 'Notes', kind: 'text' },
    { id: 'toString', label: 'Notify me', kind: 'toggle' },
  ];
  tools.show_block({ block: { id: 'volumes', type: 'form', version: 1, title: 'Volumes', fallback: 'How many?', fields } });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const block = page.locator('.transcript .block', { hasText: 'Volumes' });
  await expect(block.getByRole('switch', { name: 'Notify me' }), 'a toggle no one touched starts off').toHaveAttribute('aria-checked', 'false');
  await block.getByRole('textbox', { name: 'Questions' }).fill('12');
  await block.getByRole('button', { name: 'Send form' }).click();
  await expect(page.locator('.transcript .voice')).toHaveText('Sent: Volumes · Questions 12 · Notify me off');
  await expect(block.getByRole('textbox', { name: 'Notes' }), 'the box the person left empty').toHaveValue('');
});

// From critic’s review: the table drew and sorted a missing cell under a column with an id like “constructor” as Object’s
// own function, and a form field with such an id read as invalid before any submit.
test('#247 a table leaves a missing cell empty, and a form field isn’t invalid, whatever their ids', async ({ page }) => {
  const { rt } = app;
  const project = Object.values(rt.store.state.projects)[0];
  const thread = rt.createThread({ projectId: project.id, title: 'Shelf', personaIds: [arrange.persona(rt, 'librarian').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  const columns = [
    { id: 'name', label: 'Name' },
    { id: 'constructor', label: 'Notes' },
  ];
  const rows = [
    { id: 'r1', cells: { name: 'Emma', constructor: 'b' } },
    { id: 'r2', cells: { name: 'Persuasion' } },
    { id: 'r3', cells: { name: 'Sanditon', constructor: 'a' } },
  ];
  tools.show_block({ block: { id: 'shelf', type: 'table', version: 1, title: 'Shelf', fallback: 'Shelf', columns, rows } });
  tools.show_block({
    block: { id: 'ask', type: 'form', version: 1, title: 'Ask', fallback: 'Ask', fields: [{ id: 'constructor', label: 'Notes', kind: 'text' }] },
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const table = page.locator('.transcript .block', { hasText: 'Shelf' });
  await expect(table.locator('tbody tr').nth(1).locator('td').nth(1), 'the missing cell').toHaveText('');
  await table.getByRole('button', { name: 'Notes' }).click();
  await expect(table.locator('tbody td:first-child'), 'sorted with the missing cell first').toHaveText(['Persuasion', 'Sanditon', 'Emma']);
  const field = page.locator('.transcript .block', { hasText: 'Ask' }).getByRole('textbox', { name: 'Notes' });
  await expect(field, 'no error before any submit').not.toHaveAttribute('aria-invalid', 'true');
});
