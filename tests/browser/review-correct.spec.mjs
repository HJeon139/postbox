// #858: the person corrects a comment of theirs after submitting the review. Edit on their sent comment opens it in a
// box with its text; Send correction adds the new text after it, marked Edited, while what they sent stays; and the
// agent hears an event that names the comment it replaces. Focus then goes to the message box, as after any act. A refusal opens the box again with what was typed and why.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors } from './postbox.mjs';
import { reviewRoom, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-correct');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);

/** A review the person submitted with one comment, on line 3. */
async function sent(page, title) {
  const r = await room.withReview(page, title);
  await viewRadio(r.block, 'Lines').click();
  await r.block.locator('.g-mark[data-line="3"]').click();
  await r.block.getByRole('textbox', { name: 'Comment on line 3' }).fill('Make it bolder.');
  await r.block.getByRole('button', { name: 'Add draft comment', exact: true }).click();
  await r.block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect(r.block.locator('.answered-note')).toBeVisible();
  const edit = r.block.getByRole('button', { name: 'Edit your sent comment on line 3', exact: true });
  await expect(edit).toBeVisible();
  return { ...r, edit };
}
const corrections = (blockId) =>
  room.calls.filter((m) => m.kind === 'event' && m.event.blockId === blockId && m.event.action === 'correct').map((m) => m.event.values);

test('#858 a sent comment is corrected in place: what was sent stays, the correction follows it, and the agent hears both', async ({ page }) => {
  const { block, blockId, edit } = await sent(page, 'Correct a comment');
  await edit.click();
  const box = block.getByRole('textbox', { name: 'Edit your sent comment on line 3', exact: true });
  await expect(box, 'it opens with focus in it').toBeFocused();
  await expect(box, 'and what was sent').toHaveValue('Make it bolder.');
  await box.fill('Make it bolder, and say why.');
  await box.press('Control+Enter');
  const thread = block.locator('.rv-thread', { hasText: 'Make it bolder.' });
  await expect(thread.locator('.c'), 'what was sent, then the correction').toHaveText([/Make it bolder\./, /Edited.*Make it bolder, and say why\./]);
  await expect(page.locator('#composer-input'), 'focus goes to the message box, as after any act on a block').toBeFocused();
  await expect.poll(() => corrections(blockId)).toEqual([{ threadId: 'you-1-1', line: 3, replaces: 'Make it bolder.', text: 'Make it bolder, and say why.' }]);
});

test('#858 Cancel leaves a sent comment as it was, and a refused correction opens again with what was typed and why', async ({ page }) => {
  const { block, blockId, edit } = await sent(page, 'Refused correction');
  await edit.click();
  const box = block.getByRole('textbox', { name: 'Edit your sent comment on line 3', exact: true });
  await box.fill('Not this.');
  await block.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(box).toHaveCount(0);
  await expect(edit, 'Cancel puts focus back on Edit').toBeFocused();
  await expect(block.locator('.rv-thread .c'), 'nothing was added').toHaveCount(1);
  await edit.click();
  await expect(box, 'Cancel dropped what was typed').toHaveValue('Make it bolder.');
  // Postbox refuses it, and the browser logs the refused request.
  allowPageError(page, /status of 422/);
  const long = 'x'.repeat(4001);
  await box.fill(long);
  await block.getByRole('button', { name: 'Send correction', exact: true }).click();
  await expect(block.getByRole('alert'), 'why it was refused').toContainText('longer than 4000 characters');
  await expect(box, 'the box is open again, with what was typed').toHaveValue(long);
  expect(corrections(blockId), 'the agent heard nothing').toEqual([]);
});
