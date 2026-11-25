// Settings at the longest data it allows (#1735): a persona’s handle of 24 characters, its description of 200 and its
// host’s name of 60. At every width each row shows its host and its description whole, the bar under the list keeps
// its controls for the picked row in view, and a persona’s form shows all of its description and keeps its actions under it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const DESCRIPTION =
  'Reviews every specification, code change and layout line by line, compares each against the design documents and the house style, and reports what it found, with the evidence for each point.'.padEnd(
    200,
    '.',
  );
const HANDLES = ['principal-reviewer-of-it', 'builder'];
const hostOf = (/** @type {string} */ handle) =>
  `${'ip-10-123-45-67.us-west-2.compute.internal.example-corp.net'.padEnd(60, 'x').slice(0, 60 - handle.length)}${handle}`;

test.beforeAll(async () => {
  app = await startPostbox('settings-extreme');
  arrange.withAdapter(app.rt, { name: 'claude-code', folderFor: async () => app.root, async deliver() {} });
  for (const handle of HANDLES) {
    const persona = app.rt.createPersona({ handle, backend: 'mock', description: DESCRIPTION });
    const remote = { hostId: app.rt.addHost({ name: hostOf(handle) }).id };
    app.store.emit('persona', { ...app.store.state.personas[persona.id], backend: 'claude-code', remote });
  }
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const width of [320, 375, 800, 1280, 1920])
  test(`at ${width} px a persona row with the longest name, description and host keeps its words whole, and the bar acts on the pick`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/`);
    await synced(page, app);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Personas' }).click();
    await settled(page);
    for (const handle of HANDLES) {
      const row = dialog.locator('li.persona-row', { has: page.getByText(handle, { exact: true }) });
      await row.click();
      await expect(row, `${handle} is picked`).toHaveAttribute('aria-selected', 'true');
      // The bar under the list acts on the pick: − and Edit name it, and all of it stays in view.
      for (const name of ['New agent', `Delete ${handle}…`, `Edit ${handle}`, `Retire ${handle}`])
        await expect(dialog.getByRole('button', { name, exact: true }), `${name} is in view`).toBeInViewport({ ratio: 1 });
      // Whole: nothing cut off with an ellipsis or by the row’s edge.
      for (const words of [`On ${hostOf(handle)}`, DESCRIPTION]) {
        const cut = await row
          .getByText(words, { exact: true })
          .evaluate((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis');
        expect(cut, `“${words.slice(0, 30)}…” is whole`).toBe(false);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'the page doesn’t scroll sideways').toBe(false);

    await dialog.locator('li.persona-row', { has: page.getByText('builder', { exact: true }) }).click();
    await dialog.getByRole('button', { name: 'Edit builder', exact: true }).click();
    await settled(page);
    const what = dialog.getByLabel('What it does');
    expect(
      await what.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 || el.tagName === 'TEXTAREA'),
      'the description is a field that shows more than a line',
    ).toBe(true);
    for (const name of ['Save', 'Retire', 'Delete…']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  });

test('a description typed over several lines is saved as one, so its row in the list reads as a line', async ({ page }) => {
  const made = app.rt.createPersona({ handle: 'liner' });
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Personas' }).click();
  await dialog.locator('li.persona-row', { has: page.getByText('liner', { exact: true }) }).click();
  await dialog.getByRole('button', { name: 'Edit liner', exact: true }).click();
  await dialog.getByLabel('What it does').fill('Line one\n   line two\n');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => app.rt.store.state.personas[made.id].description).toBe('Line one line two');
});
