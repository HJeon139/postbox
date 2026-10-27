// The review block’s Preview and Lines (#179):
// - a Markdown draft opens in Preview, with its Mermaid diagram and its math drawn, in light and dark themes, and
//   takes the transcript’s width at 1280 px;
// - Preview and Lines switch from the keyboard, focus stays on the choice, and the choice holds across a reload; Lines
//   draws the diagram and math whole too;
// - a click on a diagram in Preview, which can’t be selected inside, opens Lines at its lines, with their comment box;
//   a click on text stays in Preview;
// - full screen opens and closes from the keyboard, with focus kept.
// - a revised draft’s header shows the revision Postbox counted, not one the agent left out (#248).
// review-comments.spec.mjs checks comments. Each test has a conversation of its own, where a scripted @drafter shows
// the draft (tests/browser/review.mjs). Moved from tools/check-review.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focused, frames, synced } from './postbox.mjs';
import { commentOn, drawn, reviewRoom, shown, viewRadio } from './review.mjs';

/** @type {Awaited<ReturnType<typeof reviewRoom>>} */
let room;
test.beforeAll(async () => {
  room = await reviewRoom('review');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

test('#179 the draft opens in Preview, with its diagram and math drawn, and takes the transcript’s width at 1280 px', async ({ page }) => {
  const { block } = await room.withReview(page, 'Preview');
  expect((await drawn(block, 'Preview')).preview).toBe(true);
  const width = await block.evaluate((b) => {
    const t = /** @type {Element} */ (document.querySelector('.transcript'));
    const s = getComputedStyle(t);
    return { block: b.getBoundingClientRect().width, room: t.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
  });
  expect(
    width.block > 760 && width.block >= width.room - 2,
    `the review takes the transcript’s width (${Math.round(width.block)} of ${Math.round(width.room)} px)`,
  ).toBe(true);
});

test('#179 Lines opens from the keyboard, focus stays on it, draws the diagram and math whole, shows the comment on its line, and the choice holds across a reload', async ({
  page,
}) => {
  const { block } = await room.withReview(page, 'Lines');
  await drawn(block, 'Preview');
  await commentOn(page, block, 'really bold', 'Too loud.');
  await viewRadio(block, 'Lines').focus();
  await page.keyboard.press('Enter');
  const lines = await drawn(block, 'Lines');
  expect(!lines.preview && lines.lines > 5, `Lines, not Preview (${JSON.stringify(lines)})`).toBe(true);
  await expect.poll(() => focused(page), { message: 'focus stays on Lines' }).toBe('radio: Lines');
  await expect(block.locator('.rv-line.marked .g-mark[data-line="3"]'), 'the comment on its line').toBeAttached();
  await expect(block.locator('.rv-doc .rv-thread q.rv-quote'), 'with its quote').toHaveText('really bold');
  await page.reload();
  await synced(page, room.app);
  await drawn(block, 'Lines');
  await viewRadio(block, 'Preview').click();
  await expect(viewRadio(block, 'Preview')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await synced(page, room.app);
  await drawn(block, 'Preview');
});

test('#179 a click on text stays in Preview, and one on the diagram opens Lines at its first line, with its comment box', async ({ page }) => {
  const { block } = await room.withReview(page, 'Clicks');
  await drawn(block, 'Preview');
  /** A point at the left of an element of the block, brought to the middle of the window. */
  const at = (locator) =>
    locator.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    });
  const text = await at(block.locator('.rv-preview td [data-sl]', { hasText: 'Alpha' }));
  await page.mouse.click(text.x, text.y);
  // Nothing should change here: a switch would draw Lines in the frames after the click.
  await frames(page);
  await frames(page);
  expect((await shown(block)).mode, 'a click on text stays in Preview').toBe('Preview');
  const diagram = await at(block.locator('.rv-fig .d-bar .label'));
  await page.mouse.click(diagram.x, diagram.y);
  await expect(page.getByRole('textbox', { name: 'Comment on line 12' }), 'the comment box at its first line').toBeFocused();
  expect((await shown(block)).mode).toBe('Lines');
});

test('#179 full screen opens from the keyboard, fills the window with focus on Exit full screen, and Escape brings it back', async ({ page }) => {
  const { block } = await room.withReview(page, 'Full screen');
  await block.getByRole('button', { name: 'Full screen', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(block.locator('.rv-box.rv-full')).toHaveAttribute('role', 'dialog');
  await expect.poll(() => focused(page)).toBe('button: Exit full screen');
  const fills = await block.locator('.rv-box').evaluate((b) => {
    const r = b.getBoundingClientRect();
    return r.width === innerWidth && r.height === innerHeight;
  });
  expect(fills, 'it fills the window').toBe(true);
  await page.keyboard.press('Escape');
  await expect(block.locator('.rv-box.rv-full')).toHaveCount(0);
  await expect(block.getByRole('button', { name: 'Full screen', exact: true }), 'focus back on Full screen').toBeFocused();
});

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('#179 in the dark theme too, the diagram and math are drawn', async ({ page }) => {
    const { block } = await room.withReview(page, 'Dark');
    await drawn(block, 'Preview');
  });
});

test('#248 a draft revised without a revision of its own opens each revision in Lines, as v2 then v3, with its diff', async ({ page }) => {
  const { rt } = room.app;
  const { thread, block, itemOf } = await room.withReview(page, 'Revised');
  await expect(block.locator('.block-head .small.dim').filter({ hasText: /^v\d+$/ })).toHaveText('v1');
  const changes = block.locator('[aria-label="Changes"]');
  for (const n of [2, 3]) {
    rt.sendMessage(thread.id, { text: `@drafter revise ${n}` });
    await expect.poll(() => itemOf().revision, { message: `revision ${n}` }).toBe(n);
    await room.idle();
    await synced(page, room.app);
    await expect(viewRadio(block, 'Lines'), `revision ${n} opens in Lines`).toHaveAttribute('aria-checked', 'true');
    await expect(changes.getByRole('radio'), `v${n}, with its diff`).toHaveText([`Diff v${n - 1} → v${n}`, `v${n}`]);
  }
});

test('#248 an outcome recorded on an approved review isn’t a revision: it still reads v1', async ({ page }) => {
  const { rt } = room.app;
  const { thread, block, itemOf } = await room.withReview(page, 'Filed');
  rt.act(thread.id, itemOf().id, 'submit', { verdict: 'approve', comments: [] });
  await room.idle();
  rt.sendMessage(thread.id, { text: '@drafter file' });
  await expect.poll(() => itemOf().block.outcome, { message: 'the outcome' }).toBe('Filed as #418.');
  await room.idle();
  await synced(page, room.app);
  await expect(block.locator('.outcome')).toHaveText('Filed as #418.');
  expect(itemOf().revision ?? 1, 'recording the outcome did not raise the revision').toBe(1);
  rt.patchItem(thread.id, itemOf().id, { revision: 2 }); // Older Postbox versions counted the outcome as a revision.
  await synced(page, room.app);
  await expect(block.locator('.block-head .small.dim').filter({ hasText: /^v\d+$/ })).toHaveText('v1');
});
