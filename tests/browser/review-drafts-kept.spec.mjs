// A review’s draft comments, added and not yet submitted, survive a reload (#1144), as the composer’s text draft does:
// on their lines at the same revision, and following their lines when the agent revised while the page was away.
// A submit forgets them. Each test has a conversation of its own, where a scripted @drafter shows the draft
// (tests/browser/review.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { commentOn, drawn, reviewRoom } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-drafts-kept');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** The kept drafts on this page, by key. @param {import('@playwright/test').Page} page */
const kept = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pb-review-draft-')));

/** Reloads, and waits for the review to be drawn again. */
async function reload(page, block) {
  await page.reload();
  await synced(page, room.app);
  await drawn(block, 'Preview');
}

test('#1144 a draft comment survives a reload, on its line', async ({ page }) => {
  const { block } = await room.withReview(page, 'Kept');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await reload(page, block);
  await expect(block.locator('.rv-thread', { hasText: 'Say how low.' }), 'the draft is back').toHaveCount(1);
  await expect(block.getByText('1 draft comment', { exact: true }), 'and counted as one').toBeVisible();
});

test('#1144 a draft comment follows its line into a revision made while the page was away', async ({ page }) => {
  const { block, thread, itemOf } = await room.withReview(page, 'Away');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await page.goto('about:blank');
  room.app.rt.sendMessage(thread.id, { text: '@drafter revise' });
  await expect.poll(() => itemOf().revision, { message: 'the revision' }).toBe(2);
  await room.idle();
  await page.goto(`${room.app.origin}/#/t/${thread.id}`);
  await synced(page, room.app);
  // A revision with previous opens on its diff, in Lines.
  await expect(block.locator('.rv-line').first()).toBeVisible();
  await expect(block.locator('.rv-thread', { hasText: 'Say how low.' }), 'the draft is back on the new revision').toHaveCount(1);
  // Its line is the same in the new text, so it followed it from previous, unmarked.
  await expect(block.locator('.rv-thread', { hasText: 'Say how low.' }).getByText('Its line changed'), 'not marked moved').toHaveCount(0);
});

test('#1144 submitting forgets the kept drafts', async ({ page }) => {
  const { block, itemOf } = await room.withReview(page, 'Sent');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  await expect.poll(() => kept(page), { message: 'the draft is kept' }).toHaveLength(1);
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(() => itemOf().answered, { message: 'the answer' }).toBe(true);
  await expect.poll(() => kept(page), { message: 'nothing kept once submitted' }).toEqual([]);
  await page.reload();
  await synced(page, room.app);
  await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'it stays answered').toHaveCount(0);
  expect(await kept(page)).toEqual([]);
});
