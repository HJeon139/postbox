// #518: an answer settles after the agent has already revised the block. Every revision of a review draws from one
// draft on the page, and submit() deleted that draft once its answer settled, so what the person had started on the
// newer revision in the meantime, a comment or a verdict, was lost. Now a settled answer takes back only what it sent.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
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
  app = await startPostbox('review-answer-race');
  // The agent’s turn takes the answer and ends at once, so the answer is read, and an update can reopen the block.
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#518 a draft started on a newer revision survives the older answer settling', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Race', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: DRAFT });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  // The answer reaches Postbox at once, but its reply to the page is held: the page’s submit() hasn’t settled.
  /** @type {() => void} */
  let release = () => {};
  const released = new Promise((r) => {
    release = () => r(undefined);
  });
  await page.route(`**/api/threads/${t.id}/items/${item.id}/act`, async (route) => {
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });
  // Revision 1’s answer: a comment, and Approve.
  await block.getByRole('radio', { name: 'Lines' }).click();
  await block.locator('.g-mark[data-line="3"]').click();
  await page.keyboard.insertText('Index the titles too.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('radio', { name: 'Approve', exact: true }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(() => store.item(t.id, item.id).answer?.values?.comments?.map((c) => c.text)).toEqual(['Index the titles too.']);
  await expect.poll(() => store.item(t.id, item.id).answer?.read, { message: 'the agent read the approval' }).toBe(true);
  // The agent revises, and the person starts on revision 2 before the page hears back about revision 1.
  const said = tools.update_block({ block: { ...DRAFT, content: `${DRAFT.content}\n\nThen rank.` } });
  expect(said.ok, said.message).toBe(true);
  await expect(block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  await block.locator('.g-mark[data-line="7"]').click();
  await page.keyboard.insertText('Rank by date.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await expect(block.getByText('Rank by date.')).toBeVisible();
  // Now revision 1’s answer settles.
  release();
  await page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  await synced(page, app);
  // The block is drawn again, as any change to it draws it: from the draft the page keeps for it.
  await block.getByRole('radio', { name: 'Preview' }).click();
  await block.getByRole('radio', { name: 'Lines' }).click();
  await expect(block.getByText('Rank by date.'), 'the comment on revision 2 is still a draft').toBeVisible();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => store.item(t.id, item.id).answer?.values?.comments?.map((c) => c.text), {
      message: 'revision 2’s answer carries it, and not what revision 1’s sent',
    })
    .toEqual(['Rank by date.']);
  expect(store.item(t.id, item.id).answer.revision).toBe(2);
});
