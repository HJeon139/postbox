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
