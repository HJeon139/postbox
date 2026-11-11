// An older log’s line for a dataset an agent loaded (#47) still shows who loaded what, after #516 retired datasets for
// room assets, rather than an empty line.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('system-line-dataset');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#516 an older log’s dataset line says who loaded which dataset', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'Old dataset', personaIds: [rt.personaByHandle('librarian').id] });
  rt.addItem(t.id, { kind: 'system', variant: 'dataset', handle: 'librarian', dataset: 'scifact', records: 5183 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('.sys-line', { hasText: 'loaded the dataset' })).toHaveText('librarian loaded the dataset scifact');
});
