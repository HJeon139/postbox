// The person’s submitted review comments stay on the block (#1143): right after Submit, each shows on its line once,
// drawn from the server’s threads rather than the page’s draft; and a revision, then a reload, keeps both, each on
// the line its text moved to, still open. Each test has a conversation of its own, where a scripted @drafter shows
// the draft and revises it on cue (tests/browser/review.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { commentOn, drawn, reviewRoom, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-person-threads');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const LOW = 'Say how low.';
const BOLD = 'Too loud.';

/**
 * In Lines: the lines marked as commented on, and each comment’s threads, by their status tag. A thread draws after
 * the block of lines it’s in (a table, a list), so its line is the one marked.
 * @param {import('@playwright/test').Locator} block @param {string[]} texts
 */
const placed = (block, texts) =>
  block.evaluate(
    (b, want) => ({
      marked: [...b.querySelectorAll('.rv-doc .marked .g-ln')].map((n) => Number(/\d+$/.exec(n.textContent ?? '')?.[0])),
      threads: want.map((text) =>
        [...b.querySelectorAll('.rv-doc .rv-thread')].filter((t) => t.textContent?.includes(text)).map((t) => t.querySelector('.status-tag')?.textContent),
      ),
    }),
    texts,
  );

/** The person comments on “really bold” (line 3) and “low” (line 10, a table’s row), and submits with Request changes. */
async function submitted(page, title) {
  const r = await room.withReview(page, title);
  await drawn(r.block, 'Preview');
  await commentOn(page, r.block, 'really bold', BOLD);
  await commentOn(page, r.block, 'low', LOW);
  await r.block.getByRole('radio', { name: 'Request changes', exact: true }).click();
  await r.block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect(r.block.locator('.answered-note')).toBeVisible();
  await expect.poll(() => r.itemOf().answered, { message: 'the server has the answer' }).toBe(true);
  return r;
}

test('#1143 right after Submit with Request changes, each comment shows on its line once', async ({ page }) => {
  const { block } = await submitted(page, 'Submitted');
  // In Preview, as the page drew it when the answer came back.
  for (const text of [BOLD, LOW]) await expect.soft(block.locator('.rv-preview .rv-thread', { hasText: text }), `${text} in Preview`).toHaveCount(1);
  // And drawn again, in Lines: from what the server holds, with no draft left to stand in for it.
  await viewRadio(block, 'Lines').click();
  await drawn(block, 'Lines');
  await expect
    .poll(() => placed(block, [BOLD, LOW]), { message: 'each comment on its line, once' })
    .toEqual({ marked: [3, 10], threads: [['Open'], ['Open']] });
});

test('#1143 after a revision that changes one commented line, and a reload, both comments show, each on the line its text moved to', async ({ page }) => {
  const { thread, block } = await submitted(page, 'Revised');
  await room.idle();
  room.app.rt.sendMessage(thread.id, { text: '@drafter reprice' });
  await room.idle();
  await page.reload();
  await synced(page, room.app);
  await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'the revision asks again').toBeVisible();
  await viewRadio(block, 'Lines').click();
  await drawn(block, 'Lines');
  // Two lines went in above both: “really bold” is on line 5 now, and “low” on 12, in its reworded row.
  await expect
    .poll(() => placed(block, [BOLD, LOW]), { message: 'each comment on its line, once' })
    .toEqual({ marked: [5, 12], threads: [['Open'], ['Open']] });
  await expect(block.locator('.review-bar'), 'the bar counts them').toContainText('0 of 2 resolved');
});
