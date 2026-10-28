// Comments on the review block (#179, #133):
// - selecting text in Preview shows a Comment button beside it, which Tab reaches; Enter opens the comment box, and
//   adding the comment brings focus back to the text, which is marked; the agent gets its line, columns and quote;
// - another agent’s comments (review_block, #133) show on their lines with its name, the review bar says who reviewed
//   it, and the block still waits on the person.
// review.spec.mjs checks Preview and Lines. Each test has a conversation of its own, where a scripted @drafter shows
// the draft (tests/browser/review.mjs). Moved from tools/check-review.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { commentOn, DRAFT, drawn, review, reviewRoom, select, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review-comments');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

test('#179 selecting text shows a Comment button beside it, which Tab reaches; Enter opens the box; adding brings focus back, the text marked', async ({
  page,
}) => {
  const { block } = await room.withReview(page, 'Select');
  await drawn(block, 'Preview');
  // The person drags across “really bold”, which is also where Tab goes on from. The exact range is then set, so the
  // test doesn’t rest on where a pixel falls.
  const ends = await block.evaluate((b) => {
    const walk = document.createTreeWalker(/** @type {Node} */ (b.querySelector('.rv-preview .md')), NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode())
      if (/** @type {Text} */ (t).data.includes('really bold')) {
        const at = /** @type {Text} */ (t).data.indexOf('really bold');
        const rect = (k) => {
          const r = document.createRange();
          r.setStart(t, k);
          r.setEnd(t, k + 1);
          return r.getBoundingClientRect();
        };
        const a = rect(at);
        const z = rect(at + 10);
        return [
          { x: a.left + 1, y: a.top + a.height / 2 },
          { x: z.right - 1, y: z.top + z.height / 2 },
        ];
      }
    return null;
  });
  if (!ends) throw new Error('“really bold” isn’t in Preview');
  await page.mouse.move(ends[0].x, ends[0].y);
  await page.mouse.down();
  await page.mouse.move(ends[1].x, ends[1].y);
  await page.mouse.up();
  const button = await select(block, 'really bold');
  expect(button, 'a Comment button beside the selection').toEqual({ near: true, text: 'Comment' });
  await page.keyboard.press('Tab');
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await expect(block.locator('.rv-sel'), 'Tab reaches it, and a late selectionchange leaves it there').toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Comment on “really bold”' }), 'Enter opens the comment box, with focus in it').toBeFocused();
  await page.keyboard.insertText('Too loud.');
  await page.keyboard.press('Control+Enter');
  await expect(block.locator('.rv-preview'), 'adding it brings focus back to Preview').toBeFocused();
  expect(await page.evaluate(() => getSelection()?.toString()), 'with the text selected again').toBe('really bold');
  expect(await page.evaluate(() => CSS.highlights.get('rv-quote')?.size ?? 0), 'the comment marks its text').toBeGreaterThanOrEqual(1);
  await expect(block.locator('.rv-preview .rv-thread q.rv-quote'), 'its thread quotes it').toHaveText('really bold');
});

test('#179 comments from Preview reach the agent with their line, columns and quote', async ({ page }) => {
  const { block, blockId } = await room.withReview(page, 'Submit');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'low', 'Say how low.');
  // And a word of a code block in a list item, whose lines sit past the item’s indent.
  await commentOn(page, block, 'run', 'Which script?');
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => room.calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments, { message: 'the agent gets the comments' })
    .toEqual([
      { line: 10, col: 11, endLine: 10, endCol: 13, quote: 'low', text: 'Say how low.' },
      { line: 23, col: 7, endLine: 23, endCol: 9, quote: 'run', text: 'Which script?' },
    ]);
});

test('#468 text being typed stays in its comment box when another agent comments or the author revises', async ({ page }) => {
  const { rt } = room.app;
  const { block, blockId, sessionOf } = await room.withReview(page, 'Typing');
  await viewRadio(block, 'Lines').click();
  await block.locator('.g-mark[data-line="3"]').click();
  const box = block.getByRole('textbox', { name: 'Comment on line 3' });
  await box.fill('Keep this unfinished comment.');
  for (let i = 0; i < 5; i++) await box.press('ArrowLeft');
  expect(await box.evaluate((x) => /** @type {HTMLTextAreaElement} */ (x).selectionStart), 'the person moved the caret').toBe(24);

  const reviewed = rt.toolsFor(sessionOf('reader').id).review_block({
    blockId,
    verdict: 'comment',
    comments: [{ line: 4, text: 'Another review.' }],
  });
  expect(reviewed.ok, reviewed.message).toBe(true);
  await synced(page, room.app);
  await expect(box, 'another agent’s comment keeps the unfinished text').toHaveValue('Keep this unfinished comment.');
  await expect(box, 'and focus stays in its box').toBeFocused();
  expect(await box.evaluate((x) => /** @type {HTMLTextAreaElement} */ (x).selectionStart), 'with its caret').toBe(24);

  const updated = rt.toolsFor(sessionOf('drafter').id).update_block({
    block: { ...review(sessionOf('drafter').threadId), content: `${DRAFT}\n\nOne more line.`, previous: DRAFT },
  });
  expect(updated.ok, updated.message).toBe(true);
  await synced(page, room.app);
  await expect(box, 'the author’s revision keeps the unfinished text too').toHaveValue('Keep this unfinished comment.');
  await expect(box).toBeFocused();
  expect(await box.evaluate((x) => /** @type {HTMLTextAreaElement} */ (x).selectionStart)).toBe(24);
});

test('#133 another agent’s comments show on their lines with its name; the bar says who reviewed it, and it still waits on you', async ({ page }) => {
  const { rt, store } = room.app;
  const { thread, block, blockId, itemOf, sessionOf } = await room.withReview(page, 'Reviewed');
  // @drafter revises it in a turn of its own, so it needs you for revision 2.
  rt.sendMessage(thread.id, { text: '@drafter revise' });
  await expect.poll(() => itemOf().revision, { message: 'revision 2' }).toBe(2);
  await room.idle();
  await synced(page, room.app);
  await expect(block.locator('.answered-note')).toHaveCount(0);
  const needed = store.state.sessions[sessionOf('drafter').id].needs;
  expect(needed?.itemId, '@drafter needs you for revision 2').toBe(itemOf().id);
  const said = rt.toolsFor(sessionOf('reader').id).review_block({
    blockId,
    verdict: 'request_changes',
    comments: [
      { line: 1, text: 'A clearer title.' },
      { line: 10, col: 11, endLine: 10, endCol: 19, quote: 'low price', text: 'Give the number.' },
    ],
  });
  expect(said.ok, `@reader comments on @drafter’s review (${said.message})`).toBe(true);
  await room.idle();
  await synced(page, room.app);
  await viewRadio(block, 'Lines').click();
  const thread1 = block.locator('.rv-thread').filter({ has: page.locator('.meta b', { hasText: /^@reader$/ }) });
  await expect(thread1.filter({ hasText: 'Give the number.' }).locator('q.rv-quote'), 'its quote').toHaveText('low price');
  const first = await thread1
    .filter({ hasText: 'A clearer title.' })
    .evaluate((x) => /** @type {HTMLElement | null} */ (x.previousElementSibling?.querySelector('.g-mark'))?.dataset.line);
  expect(first, 'its comment on line 1, under it').toBe('1');
  await expect(block.locator('.review-bar .rv-reviewers')).toHaveText(' · 2 comments from @reader (Request changes)');
  await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'it still waits on you').toBeVisible();
  // Its event is a turn the person didn’t start, so it leaves what @drafter needs from you as it was.
  expect(
    room.calls.some((m) => m.event?.from === 'reader'),
    '@drafter hears it',
  ).toBe(true);
  expect(store.state.sessions[sessionOf('drafter').id].needs, 'what it needs from you doesn’t change').toEqual(needed);
});
