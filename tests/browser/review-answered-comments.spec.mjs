// #716: another agent reviews a review block the person already answered. Its comments show on their lines, with its
// name, while the block stays answered as the person left it: no Submit, and the answered note still there.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { reviewRoom, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-answered-comments');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);

test('#716 a reviewer’s comments on an answered review show on their lines, and the block stays answered', async ({ page }) => {
  const { rt } = room.app;
  const { block, blockId, sessionOf } = await room.withReview(page, 'Answered, then reviewed');
  await block.getByRole('radio', { name: 'Approve', exact: true }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect(block.locator('.answered-note')).toBeVisible();
  const said = rt
    .toolsFor(sessionOf('reader').id)
    .review_block({ blockId, verdict: 'comment', comments: [{ line: 1, text: 'A read of the approved draft.' }] });
  expect(said.ok, said.message).toBe(true);
  await room.idle();
  await synced(page, room.app);
  await viewRadio(block, 'Lines').click();
  const thread = block.locator('.rv-thread').filter({ has: page.locator('.meta b', { hasText: /^reader$/ }) });
  await expect(thread, 'its comment shows').toContainText('A read of the approved draft.');
  await expect(block.locator('.answered-note'), 'still answered').toBeVisible();
  await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'nothing asks again').toHaveCount(0);
});
