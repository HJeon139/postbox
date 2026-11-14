// #1327: the Model field’s answer never moves what’s below it. While the harness is asked, the field’s help holds the
// room of the tallest message it could show for this backend, so Save stays where it was when the answer comes: a list
// that came back fresh, or one that didn’t. A notice “never moves a button under the pointer” (AGENTS.md).
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, PHONE, settled, startPostbox, synced } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('model-help-height');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A Claude Code whose listing waits until the test releases it with what it lists. */
function heldBackend() {
  let release = (/** @type {string[]} */ _models) => {};
  const answered = new Promise((r) => {
    release = r;
  });
  arrange.withAdapter(app.rt, { name: 'claude-code', capabilities: {}, listModels: () => answered, deliver: async () => {} });
  return (/** @type {string[]} */ models) => release(models);
}

let n = 0;
for (const width of [1280, 375])
  test.describe(`at ${width} px`, () => {
    if (width < 768) test.use({ viewport: { width, height: 812 }, ...PHONE });
    for (const [outcome, models] of /** @type {const} */ ([
      ['a list that came back', ['claude-opus-5-5', 'claude-sonnet-5-5']],
      ['no list', []],
    ]))
      test(`#1327 Save holds still when the Model field’s answer is ${outcome}`, async ({ page }) => {
        const answer = heldBackend();
        const persona = app.rt.createPersona({ handle: `held-${++n}`, backend: 'claude-code' });
        await page.goto(`${app.origin}/`);
        await synced(page, app);
        await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
        const sheet = page.getByRole('dialog');
        const save = sheet.getByRole('button', { name: 'Save', exact: true });
        await expect(sheet.locator('[data-model-help]')).toHaveText(/^Asking Claude Code for its models/);
        await settled(page);
        const before = await save.boundingBox();
        answer([...models]);
        await expect(sheet.locator('[data-model-help]')).toHaveCount(models.length ? 0 : 1);
        await settled(page);
        expect(await save.boundingBox(), 'Save where it was before the answer').toEqual(before);
      });
  });
