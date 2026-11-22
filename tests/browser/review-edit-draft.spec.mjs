// #858: a draft comment on a review has Edit beside Delete. Edit opens it in place with its text; saving replaces it on
// the same line, selection or app part, and the agent gets the edited text once. Cancel and Escape leave it as it was.
// In Lines (a line), Preview (a selection) and an app review (a part).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, synced } from './postbox.mjs';
import { commentOn, drawn, reviewRoom, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-edit-draft');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);

/** The comments the agent got for a block, once the person submits. */
const sent = (blockId) => room.calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments;

/** Opens a draft comment for editing, replaces its text, and saves it with Ctrl+Enter. */
async function edit(page, block, from, to) {
  const draft = block.locator('.rv-thread', { hasText: from });
  await draft.getByRole('button', { name: 'Edit', exact: true }).click();
  const box = block.getByRole('textbox', { name: 'Edit your draft comment' });
  await expect(box, 'it opens with focus in it').toBeFocused();
  await expect(box, 'and its text').toHaveValue(from);
  await box.fill(to);
  await box.press('Control+Enter');
  await expect(box).toHaveCount(0);
  await expect(block.locator('.rv-thread', { hasText: to }).getByRole('button', { name: 'Edit', exact: true }), 'focus goes back to its Edit').toBeFocused();
  await expect(block.locator('.rv-thread', { hasText: from }), 'the old text is gone').toHaveCount(0);
}

test('#858 a draft comment on a line is edited in place, and the agent gets the edited text once, on that line', async ({ page }) => {
  const { block, blockId } = await room.withReview(page, 'Edit a line');
  await viewRadio(block, 'Lines').click();
  await block.locator('.g-mark[data-line="3"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 3' }).fill('first draft');
  await block.getByRole('button', { name: 'Add draft comment', exact: true }).click();
  // Escape leaves it as it was.
  await block.locator('.rv-thread', { hasText: 'first draft' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const box = block.getByRole('textbox', { name: 'Edit your draft comment' });
  await box.fill('not this');
  await box.press('Escape');
  await expect(block.locator('.rv-thread', { hasText: 'first draft' }), 'Escape keeps the comment as it was').toHaveCount(1);
  await edit(page, block, 'first draft', 'second draft');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => sent(blockId), { message: 'the agent gets the edited comment once' })
    .toEqual([{ line: 3, text: 'second draft', threadId: 'you-1-1' }]);
});

test('#858 a draft comment on a selection in Preview keeps its quote and columns when edited', async ({ page }) => {
  const { block, blockId } = await room.withReview(page, 'Edit a selection');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await edit(page, block, 'Say how low.', 'Say how much lower.');
  await expect(block.locator('.rv-preview .rv-thread q.rv-quote'), 'it still quotes its text').toHaveText('low');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => sent(blockId))
    .toEqual([{ line: 10, col: 11, endLine: 10, endCol: 13, quote: 'low', text: 'Say how much lower.', threadId: 'you-1-1' }]);
});

test('#858 a draft comment on an app’s part keeps its part when edited', async ({ page }) => {
  const { rt, store } = room.app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Edit a part', personaIds: [arrange.persona(rt, 'drafter').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_app({ id: `chart-${t.id}`, title: 'Chart', code: '<main style="padding:12px"><p>Orders by month.</p></main>' });
  tools.show_block({
    block: { id: 'rv-app', type: 'review', version: 1, title: 'Chart', fallback: 'Review the chart.', format: 'app', appId: `chart-${t.id}` },
  });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'rv-app');
  // The person’s draft comment on the app’s “legend”, as the review keeps it over a reload (#1144).
  await page.addInitScript(
    ([key, value]) => {
      // Postbox’s own page only: the app’s sandboxed frame has no storage.
      if (window === window.top) localStorage.setItem(key, value);
    },
    [`pb-review-draft-${item.id}`, JSON.stringify({ revision: 1, verdict: 'comment', comments: [{ anchor: 'legend', text: 'Too small.' }] })],
  );
  await page.goto(`${room.app.origin}/#/t/${t.id}`);
  await synced(page, room.app);
  const block = page.locator(`[data-block-item="${item.id}"]`);
  await expect(block.locator('.rv-thread', { hasText: 'Too small.' })).toBeVisible();
  await edit(page, block, 'Too small.', 'Make the legend bigger.');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => store.item(t.id, item.id).answer?.values?.comments)
    .toEqual([{ anchor: 'legend', text: 'Make the legend bigger.', threadId: 'you-1-1' }]);
});
