// #858: a draft comment on a review has Edit beside Delete. Edit opens it in place with its text; saving replaces it on
// the same line, selection or app part, and the agent gets the edited text once. Cancel and Escape leave it as it was.
// In Lines (a line), Preview (a selection) and an app review (a part).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, synced } from './postbox.mjs';
import { commentOn, drawn, reviewRoom, viewRadio } from './review.mjs';
import { editKit } from './review-edit-fixture.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-edit-draft');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
const { sent, edit, twoDrafts } = editKit(() => room);

test('#858 a draft comment on a line is edited in place, and the agent gets the edited text once, on that line', async ({ page }) => {
  const { block, blockId } = await room.withReview(page, 'Edit a line');
  await viewRadio(block, 'Lines').click();
  await block.locator('.g-mark[data-line="3"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 3' }).fill('first draft');
  await block.getByRole('button', { name: 'Add draft comment', exact: true }).click();
  // Escape leaves it as it was.
  await block
    .locator('.rv-thread', { hasText: 'first draft' })
    .getByRole('button', { name: /^Edit your comment on / })
    .click();
  const box = block.getByRole('textbox', { name: /^Edit your comment on / });
  await box.fill('not this');
  await box.press('Escape');
  await expect(block.locator('.rv-thread', { hasText: 'first draft' }), 'Escape keeps the comment as it was').toHaveCount(1);
  await edit(block, 'first draft', 'second draft', 'line 3');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => sent(blockId), { message: 'the agent gets the edited comment once' })
    .toEqual([{ line: 3, text: 'second draft', threadId: 'you-1-1' }]);
});

test('#858 one box at a time, and what was typed in an edit is never dropped', async ({ page }) => {
  const { block, blockId, open } = await twoDrafts(page, 'One box');
  // Editing another draft keeps what was typed in the first.
  await (await open('on three')).fill('three, edited');
  await open('on five');
  await expect(block.locator('.rv-thread', { hasText: 'three, edited' }), 'the first edit is kept').toHaveCount(1);
  await expect(block.getByRole('textbox'), 'one box open').toHaveCount(1);
  // Opening a new comment’s box closes the edit, keeping it too.
  await block.getByRole('textbox', { name: /^Edit your comment on / }).fill('five, edited');
  await block.locator('.g-mark[data-line="7"]').click();
  await expect(block.getByRole('textbox'), 'only the new comment’s box').toHaveCount(1);
  await expect(block.getByRole('textbox', { name: 'Comment on line 7' })).toBeFocused();
  await expect(block.locator('.rv-thread', { hasText: 'five, edited' })).toHaveCount(1);
  await block.getByRole('textbox', { name: 'Comment on line 7' }).press('Escape');
  // Submitting with an edit open sends it as last typed.
  await (await open('three, edited')).fill('three, as sent');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(() => sent(blockId)?.map((c) => c.text)).toEqual(['three, as sent', 'five, edited']);
});

test('a comment typed in an open box but not yet added goes with Submit review, after the drafts', async ({ page }) => {
  const { block, blockId } = await twoDrafts(page, 'Submit while typing');
  await block.locator('.g-mark[data-line="7"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 7' }).fill('typed but not added');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => sent(blockId)?.map((c) => [c.line, c.text]), { message: 'the typed comment isn’t dropped' })
    .toEqual([
      [3, 'on three'],
      [5, 'on five'],
      [7, 'typed but not added'],
    ]);
});

test('#858 deleting a draft before the one being edited leaves the edit on its own comment', async ({ page }) => {
  const { block, blockId, open } = await twoDrafts(page, 'Delete before');
  await block.locator('.g-mark[data-line="7"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 7' }).fill('on seven');
  await block.getByRole('button', { name: 'Add draft comment', exact: true }).click();
  const box = await open('on five');
  await box.fill('five, edited');
  await block
    .locator('.rv-thread', { hasText: 'on three' })
    .getByRole('button', { name: /^Delete your comment on / })
    .click();
  const still = block.getByRole('textbox', { name: /^Edit your comment on / });
  await expect(still, 'the edit is still open, with what was typed').toHaveValue('five, edited');
  await still.press('Control+Enter');
  await expect(block.locator('.rv-thread', { hasText: 'on seven' }), 'the comment after it is untouched').toHaveCount(1);
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => sent(blockId)?.map((c) => [c.line, c.text]))
    .toEqual([
      [5, 'five, edited'],
      [7, 'on seven'],
    ]);
});

test('#858 deleting a draft after the one being edited leaves the edit on its own comment', async ({ page }) => {
  const { block, blockId, open } = await twoDrafts(page, 'Delete after');
  await block.locator('.g-mark[data-line="7"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 7' }).fill('on seven');
  await block.getByRole('button', { name: 'Add draft comment', exact: true }).click();
  const box = await open('on five');
  await box.fill('five, edited');
  await block
    .locator('.rv-thread', { hasText: 'on seven' })
    .getByRole('button', { name: /^Delete your comment on / })
    .click();
  const still = block.getByRole('textbox', { name: 'Edit your comment on line 5', exact: true });
  await expect(still, 'the edit is still on line 5, with what was typed').toHaveValue('five, edited');
  await still.press('Control+Enter');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => sent(blockId)?.map((c) => [c.line, c.text]))
    .toEqual([
      [3, 'on three'],
      [5, 'five, edited'],
    ]);
});

test('#858 Escape in an edit closes only the edit, in full screen too, and Save with blank text keeps the comment', async ({ page }) => {
  const { block, open } = await twoDrafts(page, 'Full screen edit');
  await block.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(block.locator('.rv-box.rv-full')).toBeVisible();
  const box = await open('on five');
  await box.press('Escape');
  await expect(block.getByRole('textbox', { name: /^Edit your comment on / }), 'the edit closed').toHaveCount(0);
  await expect(block.locator('.rv-box.rv-full'), 'full screen stays').toBeVisible();
  // Blank text isn’t a comment: Save leaves the box open and the comment as it was.
  const again = await open('on five');
  await again.fill('   ');
  await again.press('Control+Enter');
  await expect(again, 'the box stays open').toBeVisible();
  await again.press('Escape');
  await expect(block.locator('.rv-thread', { hasText: 'on five' }), 'the comment is as it was').toHaveCount(1);
});

test('#858 a draft comment on a selection in Preview keeps its quote and columns when edited', async ({ page }) => {
  const { block, blockId } = await room.withReview(page, 'Edit a selection');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await edit(block, 'Say how low.', 'Say how much lower.', '“low”');
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
  await edit(block, 'Too small.', 'Make the legend bigger.', 'legend');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => store.item(t.id, item.id).answer?.values?.comments)
    .toEqual([{ anchor: 'legend', text: 'Make the legend bigger.', threadId: 'you-1-1' }]);
});
