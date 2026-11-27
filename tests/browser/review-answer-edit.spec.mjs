// #518: a newer revision drawn after an older answer landed takes what that answer sent out of the draft, saving an
// edit open first. When the answer took nothing (the page drew the block answered, which emptied the draft), an edit
// the person opened on the newer revision stays open through the next redraw.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { holdAct } from './answer-hold.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const DRAFT = {
  id: 'plan',
  type: 'review',
  version: 1,
  title: 'Plan',
  fallback: 'Review the plan',
  format: 'markdown',
  content: '# Plan\n\nIndex first.\n\nThen search.',
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('review-answer-edit');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** In Lines, a comment on a line, added as a draft. */
async function comment(page, block, line, text) {
  await block.locator(`.g-mark[data-line="${line}"]`).click();
  await page.keyboard.insertText(text);
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await expect(block.getByText(text)).toBeVisible();
}

test('#518 an edit open on revision 2 stays open through a redraw when the older answer took nothing from the draft', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: 'Edit kept open',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: DRAFT });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  const { release } = await holdAct(page, t.id, item.id);
  await block.getByRole('radio', { name: 'Lines' }).click();
  await comment(page, block, 3, 'Index the titles too.');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(() => store.item(t.id, item.id).answer?.read).toBe(true);
  expect(tools.update_block({ block: { ...DRAFT, content: `${DRAFT.content}\n\nThen rank.` } }).ok).toBe(true);
  await expect(block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  const settled = page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  release();
  await settled;
  await comment(page, block, 7, 'Rank by date.');
  await block.getByRole('button', { name: 'Edit your comment on line 7' }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' And by author.');
  await block.getByRole('radio', { name: 'Preview' }).click();
  await block.getByRole('radio', { name: 'Lines' }).click();
  await expect(block.locator('textarea'), 'the edit is still open').toHaveValue('Rank by date. And by author.');
});
