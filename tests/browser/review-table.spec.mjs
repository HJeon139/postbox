// A table in a Markdown review’s Lines (#835): its delimiter row (|---|---|) is a line of the draft, which an agent’s
// review_block can comment on, so it shows as a row of its own, with its number and comment button, between the
// header and the first body row. The numbers beside the table run on without a gap, and a comment the person adds on
// the delimiter’s line reaches the agent on that line. The draft is tests/browser/review.mjs’s: its table is lines
// 8 to 10, the delimiter line 9.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { reviewRoom, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-table');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** Opens a review of its own in Lines, and returns the block and its table. @param {any} page @param {string} title */
async function inLines(page, title) {
  const r = await room.withReview(page, title);
  await viewRadio(r.block, 'Lines').click();
  const table = r.block.locator('.md-table');
  await expect(table).toBeVisible();
  return { ...r, table };
}

/**
 * The line of the row before a thread’s row in the table, or null when the thread isn’t in a row of the table.
 * @param {import('@playwright/test').Locator} thread
 */
const lineAbove = (thread) =>
  thread.evaluate(
    (x) => /** @type {HTMLElement | null} */ (x.closest('.md-table tr')?.previousElementSibling?.querySelector('.g-mark') ?? null)?.dataset.line ?? null,
  );

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use(width === 375 ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});

    test(`#835 the numbers beside a table run on without a gap, the delimiter’s row with its number and comment button (${width} px)`, async ({ page }) => {
      const { block, table } = await inLines(page, `Numbers ${width}`);
      const marks = await table
        .locator('.g-mark')
        .evaluateAll((ms) => ms.map((m) => ({ line: /** @type {HTMLElement} */ (m).dataset.line, top: m.getBoundingClientRect().top })));
      expect
        .soft(
          marks.map((m) => m.line),
          'every line of the table, the delimiter too',
        )
        .toEqual(['8', '9', '10']);
      expect
        .soft(
          marks.every((m, i) => i === 0 || m.top > marks[i - 1].top),
          'each number below the one before it',
        )
        .toBe(true);
      const lines = await block.locator('.g-mark').evaluateAll((ms) => ms.map((m) => Number(/** @type {HTMLElement} */ (m).dataset.line)));
      expect.soft(lines.slice(lines.indexOf(7), lines.indexOf(11) + 1), 'and on from the line before it to the line after it').toEqual([7, 8, 9, 10, 11]);
      const delimiter = table.locator('tr', { has: page.locator('.g-mark[data-line="9"]') });
      await expect.soft(delimiter, 'the delimiter’s row shows its source').toContainText('|---|---|');
      await expect.soft(block.getByRole('button', { name: 'Comment on line 9', exact: true }), 'and has a comment button').toBeVisible();
    });

    test(`#835 another agent’s comment on the delimiter’s line shows in the table, under its row (${width} px)`, async ({ page }) => {
      const { block, blockId, sessionOf } = await inLines(page, `Agent ${width}`);
      const said = room.app.rt
        .toolsFor(sessionOf('reader').id)
        .review_block({ blockId, verdict: 'comment', comments: [{ line: 9, text: 'Align the cost right.' }] });
      expect(said.ok, said.message).toBe(true);
      await room.idle();
      await synced(page, room.app);
      const thread = block.locator('.rv-thread', { hasText: 'Align the cost right.' });
      await expect(thread).toBeVisible();
      expect(await lineAbove(thread), 'in the table, right under line 9').toBe('9');
    });

    test(`#835 the person’s comment from the delimiter’s comment button reaches the agent on its line (${width} px)`, async ({ page }) => {
      const { block, blockId } = await inLines(page, `Person ${width}`);
      const button = block.getByRole('button', { name: 'Comment on line 9', exact: true });
      await expect(button, 'the delimiter’s line has a comment button').toBeVisible();
      await button.click();
      await expect(page.getByRole('textbox', { name: 'Comment on line 9' }), 'the button opens line 9’s comment box').toBeFocused();
      await page.keyboard.insertText('Center the cost.');
      await page.keyboard.press('Control+Enter');
      await expect(block.locator('.g-mark[data-line="9"]'), 'adding it brings focus back to line 9').toBeFocused();
      await block.getByRole('button', { name: 'Submit review', exact: true }).click();
      await expect
        .poll(() => room.calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments, { message: 'the agent gets the comment' })
        .toEqual([{ line: 9, text: 'Center the cost.' }]);
    });
  });
}
