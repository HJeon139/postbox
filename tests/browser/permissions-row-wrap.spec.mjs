// In the permissions panel, a deny row’s long tool list took the row, and its source (“from the persona’s Tools:
// agents.outside is unticked”) was left a 30 px column, one word a line (UAT of 26 Nov).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room;
test.beforeAll(async () => {
  app = await startPostbox('permissions-row-wrap');
  const { rt } = app;
  const personas = ['indexer', 'researcher'].map((handle) => arrange.persona(rt, handle) ?? rt.createPersona({ handle }));
  room = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Index planning', personaIds: personas.map((p) => p.id) });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a deny row’s source keeps room to read at 1280 px, beside a long list of tools', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Manage Index planning' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Permissions…', exact: true }).click();
  const deny = page.getByRole('list', { name: 'Deny' });
  const rows = deny.locator('li').filter({ hasText: 'is unticked' });
  await expect(rows.first()).toBeVisible();
  await settled(page);
  const narrow = await rows.evaluateAll((lis) =>
    lis
      .map((li) => /** @type {HTMLElement} */ (li.querySelector('.grow')))
      .filter((s) => s && s.getBoundingClientRect().width < 200)
      .map((s) => `${Math.round(s.getBoundingClientRect().width)} px: ${s.textContent}`),
  );
  expect(narrow, 'no source squeezed under 200 px').toEqual([]);
});
