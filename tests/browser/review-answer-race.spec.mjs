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

/** A gate a test opens: wait() resolves once open() is called. */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((r) => {
    open = () => r(undefined);
  });
  return { open, wait: () => opened };
}

/**
 * Holds a block’s answer on its way: its reply to the page until release(), and, with untilSent, the request itself
 * until send(). @param {import('@playwright/test').Page} page @param {string} threadId @param {string} itemId
 */
async function holdAct(page, threadId, itemId, { untilSent = false } = {}) {
  const sent = gate();
  const released = gate();
  if (!untilSent) sent.open();
  await page.route(`**/api/threads/${threadId}/items/${itemId}/act`, async (route) => {
    await sent.wait();
    const response = await route.fetch();
    await released.wait();
    await route.fulfill({ response });
  });
  return { send: sent.open, release: released.open };
}

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
  const { release } = await holdAct(page, t.id, item.id);
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
  // A reload before anything draws the block again still has the draft: what’s kept is the draft as it is now.
  await page.reload();
  await synced(page, app);
  await expect(block.getByText('Rank by date.'), 'kept over a reload').toBeVisible();
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

test('#518 when the page never drew the answered block, the older answer’s comments and verdict don’t carry into the newer revision', async ({ page }) => {
  const { rt, store } = app;
  const projectId = Object.values(store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Away', personaIds: [arrange.persona(rt, 'researcher').id] });
  const elsewhere = rt.createThread({ projectId, title: 'Elsewhere', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: DRAFT });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  // The answer is held before it reaches Postbox, then sent once the page is elsewhere, so it lands while the block
  // isn’t drawn; its reply to the page is held until after the agent revises.
  const { send, release } = await holdAct(page, t.id, item.id, { untilSent: true });
  await block.getByRole('radio', { name: 'Lines' }).click();
  await block.locator('.g-mark[data-line="3"]').click();
  await page.keyboard.insertText('Index the titles too.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('radio', { name: 'Approve', exact: true }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  // The person goes to another conversation while the answer is on its way, so the page never draws it answered.
  await page.goto(`${app.origin}/#/t/${elsewhere.id}`);
  await synced(page, app);
  send();
  await expect.poll(() => store.item(t.id, item.id).answer?.read, { message: 'the agent read the approval' }).toBe(true);
  const said = tools.update_block({ block: { ...DRAFT, content: `${DRAFT.content}\n\nThen rank.` } });
  expect(said.ok, said.message).toBe(true);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  release();
  await page.waitForResponse(`**/api/threads/${t.id}/items/${item.id}/act`);
  await block.getByRole('radio', { name: 'Preview' }).click();
  await block.getByRole('radio', { name: 'Lines' }).click();
  // Sent, it stays on the block as the person’s thread; it mustn’t also be a draft, to be sent again.
  const drafted = block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'revision 1’s comment isn’t a draft on revision 2').toHaveCount(0);
  await expect(block.getByRole('radio', { name: 'Approve', exact: true }), 'nor is its verdict').toHaveAttribute('aria-checked', 'false');
});
