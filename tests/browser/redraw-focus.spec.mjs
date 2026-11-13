// #739: typing in a choice’s free text, a redraw of the conversation keeps the text, the focus and the caret, so the
// next keys land in the field. Three redraws lost focus to the page: the block moving to the newest point, a full
// reload of the state, and an agent joining. A patch kept focus but put the
// caret at the end. An agent joining also took focus from the composer, which the rebuild remounts.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

const OTHER = 'A bucket name';
const choice = (prompt) => ({
  id: 'bucket',
  type: 'choice',
  version: 1,
  title: 'Which bucket?',
  fallback: 'Which bucket?',
  prompt,
  options: [
    { id: 'default', label: 'The default' },
    { id: 'new', label: 'A new one' },
  ],
  other: { label: OTHER, placeholder: 'my-bucket' },
});
const card = (id) => ({ id, type: 'card', version: 1, title: `Card ${id}`, fallback: `Card ${id}`, body: 'Something else happened.' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let asker;
let helper;
let joiner;
test.beforeAll(async () => {
  app = await startPostbox('redraw-focus');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
  asker = app.rt.createPersona({ handle: 'asker' });
  helper = app.rt.createPersona({ handle: 'helper' });
  joiner = app.rt.createPersona({ handle: 'joiner' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

let n = 0;
/** A conversation whose choice has “my-buck” typed in its free text, focused, with “y-” selected backward. */
async function typing(page, width, before) {
  await page.setViewportSize({ width, height: 800 });
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: `Focus ${++n}`, personaIds: [asker.id, helper.id] });
  const toolsOf = (pid) => rt.toolsFor(arrange.sessionsIn(rt, thread.id).find((s) => s.personaId === pid).id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  toolsOf(asker.id).show_block({ block: choice('Name the bucket.') });
  const itemOf = () => rt.store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === 'bucket');
  await expect.poll(() => !!itemOf()).toBe(true);
  const block = page.locator(`[data-block-item="${itemOf().id}"]`);
  await expect(block).toBeVisible();
  if (before) await before({ toolsOf, page });
  await block.getByRole('radio', { name: OTHER }).click();
  const field = block.locator('input.input');
  await field.click();
  await page.keyboard.type('my-buck');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect(field).toBeFocused();
  return { rt, thread, toolsOf, block, itemOf };
}

/** After the redraw: the text, the focus and the selection are where they were, and the next key replaces it. */
async function kept(page, s) {
  await synced(page, app);
  await frames(page);
  const now = await page.evaluate(() => {
    const a = /** @type {HTMLInputElement} */ (document.activeElement);
    return { focus: a?.id || a?.tagName, start: a?.selectionStart ?? null, end: a?.selectionEnd ?? null };
  });
  const field = s.block.locator('input.input');
  expect.soft(await field.inputValue(), 'the typed text').toBe('my-buck');
  expect.soft(now, 'focus and selection').toEqual({ focus: `${s.itemOf().id}-other`, start: 1, end: 3 });
  await page.keyboard.type('X');
  expect.soft(await field.inputValue(), 'the next key replaces the selection').toBe('mXbuck');
}

for (const width of [1280, 375]) {
  test(`#739 the block updated and moved to the newest point keeps focus and caret, at ${width}`, async ({ page }) => {
    const s = await typing(page, width, async ({ toolsOf, page }) => {
      toolsOf(helper.id).show_block({ block: card('first') });
      await expect(page.getByText('Card first')).toBeVisible();
    });
    s.toolsOf(asker.id).update_block({ block: choice('Name the bucket. Lowercase only.') });
    await expect(s.block).toContainText('Lowercase only');
    await kept(page, s);
  });

  test(`#739 a full reload of the state keeps focus and caret, at ${width}`, async ({ page }) => {
    const s = await typing(page, width);
    await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
    await kept(page, s);
  });

  test(`#739 an agent joining, which rebuilds the view, keeps focus and caret, at ${width}`, async ({ page }) => {
    const s = await typing(page, width);
    s.rt.ensureSession(s.thread.id, joiner.id);
    s.toolsOf(joiner.id).show_block({ block: card('joined') });
    await expect(page.getByText('Card joined')).toBeVisible();
    await kept(page, s);
  });

  test(`#739 the block updated in place, and another agent’s card, keep focus and now the caret too, at ${width}`, async ({ page }) => {
    const s = await typing(page, width);
    s.toolsOf(asker.id).update_block({ block: choice('Name the bucket. Lowercase only.') });
    await expect(s.block).toContainText('Lowercase only');
    s.toolsOf(helper.id).show_block({ block: card('second') });
    await expect(page.getByText('Card second')).toBeVisible();
    await kept(page, s);
  });
}

test('#739 a reload and an agent joining keep focus in the composer, and never take it into the conversation', async ({ page }) => {
  const s = await typing(page, 1280);
  const composer = page.locator('#composer-input');
  await composer.click();
  await page.keyboard.type('a note');
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  s.rt.ensureSession(s.thread.id, joiner.id);
  await synced(page, app);
  await frames(page);
  await expect(composer).toBeFocused();
  await page.keyboard.type('!');
  await expect(composer).toHaveValue('a note!');
});

test('#739 control: a check that can tell a lost focus', async ({ page }) => {
  test.fail();
  const s = await typing(page, 1280);
  await page.locator('#composer-input').focus();
  await kept(page, s);
});

test('#739 a field that comes back as a date input gets focus back without a caret, and nothing throws', async ({ page }) => {
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: `Focus ${++n}`, personaIds: [asker.id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  const form = (kind) => ({ id: 'when', type: 'form', version: 1, fallback: 'When?', fields: [{ id: 'day', label: 'Which day?', kind }] });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  tools.show_block({ block: form('text') });
  const field = page.getByRole('textbox', { name: 'Which day?' });
  await field.click();
  await page.keyboard.type('Friday');
  const id = await field.evaluate((f) => f.id);
  tools.update_block({ block: form('date') });
  await expect(page.locator(`#${id}`)).toHaveAttribute('type', 'date');
  await synced(page, app);
  await frames(page);
  await expect(page.locator(`#${id}`)).toBeFocused();
});
