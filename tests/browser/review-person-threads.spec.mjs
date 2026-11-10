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
const RUN = 'Which script?';

/**
 * In Lines, each thread holding text: the line it’s drawn under (the last line number before it), and its status tag.
 * @param {import('@playwright/test').Locator} block @param {string[]} texts
 */
const placed = (block, texts) =>
  block.evaluate((b, want) => {
    const nums = [...b.querySelectorAll('.rv-doc .g-ln')];
    return want.map((text) => {
      const at = [...b.querySelectorAll('.rv-doc .rv-thread')].filter((t) => t.textContent?.includes(text));
      return at.map((t) => {
        const before = nums.filter((n) => n.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { line: Number(/\d+$/.exec(before.at(-1)?.textContent ?? '')?.[0]), status: t.querySelector('.status-tag')?.textContent };
      });
    });
  }, texts);

/** The person comments on “low” (line 10) and “run” (line 23), and submits with Request changes. */
async function submitted(page, title) {
  const r = await room.withReview(page, title);
  await drawn(r.block, 'Preview');
  await commentOn(page, r.block, 'low', LOW);
  await commentOn(page, r.block, 'run', RUN);
  await r.block.getByRole('radio', { name: 'Request changes', exact: true }).click();
  await r.block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect(r.block.locator('.answered-note')).toBeVisible();
  await expect.poll(() => r.itemOf().answered, { message: 'the server has the answer' }).toBe(true);
  return r;
}

test('#1143 right after Submit with Request changes, each comment shows on its line once', async ({ page }) => {
  const { block } = await submitted(page, 'Submitted');
  // In Preview, as the page drew it when the answer came back.
  for (const text of [LOW, RUN]) await expect.soft(block.locator('.rv-preview .rv-thread', { hasText: text }), `${text} in Preview`).toHaveCount(1);
  // And drawn again, in Lines: from what the server holds, with no draft left to stand in for it.
  await viewRadio(block, 'Lines').click();
  await drawn(block, 'Lines');
  await expect
    .poll(() => placed(block, [LOW, RUN]), { message: 'each comment on its line, once' })
    .toEqual([[{ line: 10, status: 'Open' }], [{ line: 23, status: 'Open' }]]);
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
  // Two lines went in above both: “low” is on line 12 now, in its reworded row, and “run” on 25.
  await expect
    .poll(() => placed(block, [LOW, RUN]), { message: 'each comment on its line, once' })
    .toEqual([[{ line: 12, status: 'Open' }], [{ line: 25, status: 'Open' }]]);
  await expect(block.locator('.review-bar'), 'the bar counts them').toContainText('0 of 2 resolved');
});
