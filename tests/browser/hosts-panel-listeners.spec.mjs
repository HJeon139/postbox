// Leaving Settings’ Hosts tab stops its listener and its clock (#945). The panel listened until it had once been seen
// on the page by a change or its 30 s tick, so a panel left before either, by another tab or by closing Settings,
// listened, and ticked, for good, holding the panel. Opened and left five times with no change between, then one
// change: the page’s listeners are back where they started.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('hosts-panel-listeners');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const listeners = (page) => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.listeners.size));

test('#945 the Hosts tab left before any change stops listening once a change comes', async ({ page }) => {
  await page.goto(app.origin);
  await synced(page, app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas')));
  const tabs = page.locator('.dialog');
  await expect(tabs.getByRole('tab', { name: 'Personas' })).toHaveAttribute('aria-selected', 'true');
  const before = await listeners(page);
  for (let i = 0; i < 5; i++) {
    await tabs.getByRole('tab', { name: 'Hosts' }).click();
    await expect(tabs.getByRole('tab', { name: 'Hosts' })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: 'Personas' }).click();
    await expect(tabs.getByRole('tab', { name: 'Personas' })).toHaveAttribute('aria-selected', 'true');
  }
  // One change for every listener to hear: a panel that’s gone stops on it.
  app.rt.createPersona({ handle: 'a-change' });
  await synced(page, app);
  expect(await listeners(page), 'the page’s listeners after five visits to Hosts and one change').toBe(before);
});
