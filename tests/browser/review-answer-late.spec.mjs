// #518: another page’s answer landed, and the agent revised, before this page heard either. The person submits the
// revision they still see; the server refuses it as stale. When the page catches up and draws the newer revision, the
// answer that landed came before the click, so it can’t have taken what the click sent: the comment is still a draft.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { gate } from './answer-hold.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { away } from './resync-fixture.mjs';

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
  app = await startPostbox('review-answer-late');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#518 an answer that landed elsewhere before the click, drawn late, leaves what the click sent as a draft', async ({ page }) => {
  allowPageError(page, /status of 409/);
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Late', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: DRAFT });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'plan');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  await block.getByRole('radio', { name: 'Lines' }).click();
  await block.locator('.g-mark[data-line="3"]').click();
  await page.keyboard.insertText('Index the titles too.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  // The page stops hearing; another page dismisses revision 1, and the agent revises.
  const resume = await away(app, page);
  rt.act(t.id, item.id, 'dismiss', {}, 1);
  await expect.poll(() => store.item(t.id, item.id).answer?.read).toBe(true);
  expect(tools.update_block({ block: { ...DRAFT, content: `${DRAFT.content}\n\nThen rank.` } }).ok).toBe(true);
  // The person submits revision 1, still on screen; the refusal is held until the page has caught up.
  const reply = gate();
  await page.route(`**/api/threads/${t.id}/items/${item.id}/act`, async (route) => {
    const response = await route.fetch();
    await reply.wait();
    await route.fulfill({ response });
  });
  const refused = page.waitForResponse((res) => res.url().endsWith(`/items/${item.id}/act`) && res.status() === 409);
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await resume();
  await expect(block.locator('.rv-receipt'), 'revision 2 is drawn').toBeVisible();
  const drafted = block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'Index the titles too.' }), 'the comment the server refused is a draft').toHaveCount(1);
  reply.open();
  await refused;
  await expect(drafted.filter({ hasText: 'Index the titles too.' })).toHaveCount(1);
});
