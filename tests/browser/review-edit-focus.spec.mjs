// #858: a review’s comment boxes, the new comment’s and a draft’s open for editing, over a repaint. Each keeps its
// text, caret and focus, takes focus back only if it had it, and never from another review’s box or the message box.
// Text a new comment’s box had when Edit closed it comes back with its place. Moved from review-edit-draft.spec.mjs.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { away } from './resync-fixture.mjs';
import { DRAFT, review, reviewRoom, viewRadio } from './review.mjs';
import { editKit } from './review-edit-fixture.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-edit-focus');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
const { twoDrafts } = editKit(() => room);

test('#858 an edit keeps its text, caret and focus when another agent comments', async ({ page }) => {
  const { rt } = room.app;
  const { blockId, sessionOf, open } = await twoDrafts(page, 'Keep caret');
  const box = await open('on five');
  await box.fill('five, being edited');
  for (let i = 0; i < 7; i++) await box.press('ArrowLeft');
  const reviewed = rt.toolsFor(sessionOf('reader').id).review_block({ blockId, verdict: 'comment', comments: [{ line: 4, text: 'Another review.' }] });
  expect(reviewed.ok, reviewed.message).toBe(true);
  await synced(page, room.app);
  await expect(box, 'its text').toHaveValue('five, being edited');
  await expect(box, 'its focus').toBeFocused();
  expect(await box.evaluate((x) => /** @type {HTMLTextAreaElement} */ (x).selectionStart), 'its caret').toBe(11);
});

test('#858 opening Edit sets a new comment’s unfinished text aside, and reopening its line brings it back', async ({ page }) => {
  const { block, open } = await twoDrafts(page, 'Set aside');
  await block.locator('.g-mark[data-line="7"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 7' }).fill('half a thought');
  await (await open('on three')).press('Escape');
  // A detour to another line’s box, opened and closed, doesn’t take it.
  await block.locator('.g-mark[data-line="6"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 6' }).press('Escape');
  await block.locator('.g-mark[data-line="7"]').click();
  await expect(block.getByRole('textbox', { name: 'Comment on line 7' }), 'its text is back').toHaveValue('half a thought');
});

test('#858 a repaint leaves focus in the message box when the person moved there from an edit', async ({ page }) => {
  const { rt } = room.app;
  const { blockId, sessionOf, open } = await twoDrafts(page, 'Focus stays');
  await (await open('on five')).fill('five, being edited');
  const message = page.locator('#composer-input');
  await message.click();
  await expect(message).toBeFocused();
  const reviewed = rt.toolsFor(sessionOf('reader').id).review_block({ blockId, verdict: 'comment', comments: [{ line: 4, text: 'Another review.' }] });
  expect(reviewed.ok, reviewed.message).toBe(true);
  await synced(page, room.app);
  await expect(page.locator('.rv-thread', { hasText: 'Another review.' })).toBeVisible();
  await expect(message, 'the repaint leaves focus in the message box').toBeFocused();
  await expect(page.getByRole('textbox', { name: /^Edit your comment on / }), 'and the edit stays open, with its text').toHaveValue('five, being edited');
});

test('#858 a repaint leaves focus in the message box when the person moved there from a new comment’s box', async ({ page }) => {
  const { rt } = room.app;
  const { block, blockId, sessionOf } = await room.withReview(page, 'Focus stays, new');
  await viewRadio(block, 'Lines').click();
  await block.locator('.g-mark[data-line="3"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 3' }).fill('half a thought');
  const message = page.locator('#composer-input');
  await message.click();
  const reviewed = rt.toolsFor(sessionOf('reader').id).review_block({ blockId, verdict: 'comment', comments: [{ line: 4, text: 'Another review.' }] });
  expect(reviewed.ok, reviewed.message).toBe(true);
  await synced(page, room.app);
  await expect(block.locator('.rv-thread', { hasText: 'Another review.' })).toBeVisible();
  await expect(message, 'the repaint leaves focus in the message box').toBeFocused();
  await expect(block.getByRole('textbox', { name: 'Comment on line 3' })).toHaveValue('half a thought');
});

test('#858 one review’s repaint leaves focus in another review’s comment box', async ({ page }) => {
  const { rt, store } = room.app;
  const { thread, block, blockId, sessionOf } = await room.withReview(page, 'Two reviews');
  rt.toolsFor(sessionOf('drafter').id).show_block({ block: { ...review(thread.id), id: 'second', title: 'Second' } });
  await synced(page, room.app);
  const second = page.locator(`[data-block-item="${store.items(thread.id).find((i) => i.block?.id === 'second').id}"]`);
  for (const b of [block, second]) {
    await viewRadio(b, 'Lines').click();
    await b.locator('.g-mark[data-line="3"]').click();
    // Focus leaves the box for nothing in particular, as a click on the page’s background does, so the first review
    // still holds that its box had focus last.
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  }
  await second.getByRole('textbox', { name: 'Comment on line 3' }).click();
  const typing = second.getByRole('textbox', { name: 'Comment on line 3' });
  await typing.fill('in the second');
  await expect(block.getByRole('textbox', { name: 'Comment on line 3' }), 'the first review’s box is still open').toBeVisible();
  const reviewed = rt.toolsFor(sessionOf('reader').id).review_block({ blockId, verdict: 'comment', comments: [{ line: 4, text: 'On the first.' }] });
  expect(reviewed.ok, reviewed.message).toBe(true);
  await synced(page, room.app);
  await expect(block.locator('.rv-thread', { hasText: 'On the first.' })).toBeVisible();
  await expect(typing, 'focus stays in the second review’s box').toBeFocused();
});

test('#858 a resync keeps focus in the open edit box', async ({ page }) => {
  const { open } = await twoDrafts(page, 'Resync edit');
  const box = await open('on five');
  await box.fill('five, during a resync');
  const resync = await away(room.app, page);
  await resync();
  await expect(box, 'its text').toHaveValue('five, during a resync');
  await expect(box, 'and its focus').toBeFocused();
});

test('#858 a new comment’s text set aside for an edit follows its line when the agent revises', async ({ page }) => {
  const { rt } = room.app;
  const { block, sessionOf, open } = await twoDrafts(page, 'Set aside, revised');
  await block.locator('.g-mark[data-line="7"]').click();
  await block.getByRole('textbox', { name: 'Comment on line 7' }).fill('half a thought');
  await open('on three');
  const drafter = sessionOf('drafter');
  const revised = rt.toolsFor(drafter.id).update_block({ block: { ...review(drafter.threadId), content: `New first line.\n${DRAFT}`, previous: DRAFT } });
  expect(revised.ok, revised.message).toBe(true);
  await synced(page, room.app);
  await block.getByRole('textbox', { name: /^Edit your comment on / }).press('Escape');
  await block.locator('.g-mark[data-line="8"]').click();
  await expect(block.getByRole('textbox', { name: 'Comment on line 8' }), 'its text is on the line it moved to').toHaveValue('half a thought');
});
