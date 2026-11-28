// The review block’s Preview and Lines (#179):
// - a Markdown draft opens in Preview, with its Mermaid diagram and its math drawn, in light and dark themes, and
//   takes the transcript’s width at 1280 px;
// - Preview and Lines switch from the keyboard, focus stays on the choice, and the choice holds across a reload; Lines
//   draws the diagram and math whole too;
// - a click on a diagram in Preview, which can’t be selected inside, opens Lines at its lines, with their comment box;
//   a click on text stays in Preview;
// - full screen opens and closes from the keyboard, with focus kept.
// - a revised draft’s header shows the revision Postbox counted, not one the agent left out (#248).
// - a diagram drawn again as the review redraws starts at its height, so a press on Submit as it draws isn’t lost.
// review-comments.spec.mjs checks comments. Each test has a conversation of its own, where a scripted @drafter shows
// the draft (tests/browser/review.mjs). Moved from tools/check-review.mjs (#303).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { pageWidth } from './page-width.mjs';
import { failOnPageErrors, focused, frames, PHONE, settled, synced, windowWidth } from './postbox.mjs';
import { commentOn, drawn, review, reviewRoom, shown, viewRadio } from './review.mjs';

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

test('#486 Preview fills a wide review while conversation prose keeps its reading measure, with no narrow change', async ({ page }) => {
  const { rt } = room.app;
  const { thread, block, blockId, sessionOf } = await room.withReview(page, 'Preview width');
  const text = Array.from({ length: 30 }, () => 'The rendered review uses all of the space available for detailed feedback.').join(' ');
  const updated = rt.toolsFor(sessionOf('drafter').id).update_block({ block: { ...review(thread.id), content: text } });
  expect(updated.ok, updated.message).toBe(true);
  const reviewed = rt.toolsFor(sessionOf('reader').id).review_block({
    blockId,
    verdict: 'comment',
    comments: [{ line: 1, text }],
  });
  expect(reviewed.ok, reviewed.message).toBe(true);
  arrange.post(rt, thread.id, { kind: 'user', text });
  await synced(page, room.app);

  const widths = async () =>
    block.evaluate((b) => {
      const preview = /** @type {HTMLElement} */ (b.querySelector('.rv-preview'));
      const paragraph = /** @type {HTMLElement} */ (preview.querySelector(':scope > .md > p'));
      const thread = /** @type {HTMLElement} */ (preview.querySelector('.rv-thread'));
      const style = getComputedStyle(preview);
      return {
        available: preview.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        paragraph: paragraph.getBoundingClientRect().width,
        thread: thread.getBoundingClientRect().width,
      };
    });
  const wide = await widths();
  expect(wide.paragraph, `the paragraph fills ${Math.round(wide.available)} px`).toBeGreaterThanOrEqual(wide.available - 2);
  expect(wide.thread, `the comment thread fills ${Math.round(wide.available)} px`).toBeGreaterThanOrEqual(wide.available - 2);
  const message = page.locator('.turn.me .me-card .md p', { hasText: 'The rendered review' });
  expect(await message.evaluate((p) => p.getBoundingClientRect().width), 'conversation prose keeps its reading measure').toBeLessThan(wide.paragraph - 100);

  await page.setViewportSize({ width: 375, height: 812 });
  await settled(page);
  const narrow = await widths();
  expect(narrow.paragraph, 'the paragraph still fits at 375 px').toBeLessThanOrEqual(narrow.available + 1);
  expect(narrow.thread, 'the thread still fits at 375 px').toBeLessThanOrEqual(narrow.available + 1);
  const viewport = windowWidth(page);
  expect(await pageWidth(page), 'nothing widens the narrow page').toBeLessThanOrEqual(viewport);
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
  arrange.setItem(rt, thread.id, itemOf().id, { revision: 2 }); // Older Postbox versions counted the outcome as a revision.
  await synced(page, room.app);
  await expect(block.locator('.block-head .small.dim').filter({ hasText: /^v\d+$/ })).toHaveText('v1');
});

// A review draws its diagram again each time it redraws, here as the comment box closes. On CI’s runner Mermaid’s
// drawing held the page, and the new frame’s size came between the press on Submit and its release: a frame that
// started at the stylesheet’s 160 px grew to the diagram’s height, Submit moved under the pointer, and the release
// landed beside it, so the browser fired no click and the review never went (review-table.spec.mjs, 375 px). The test
// holds the diagrams’ size messages and lets them through as the press goes down, then releases the mouse at once.
test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, ...PHONE });

  test('a press on Submit as the redrawn diagram draws still submits: the frame starts at its diagram’s height', async ({ page }) => {
    const { block, blockId } = await room.withReview(page, 'Press as it draws');
    await viewRadio(block, 'Lines').click();
    await expect(block.locator('figure.diagram iframe[data-sized]'), 'the diagram drawn once').toHaveCount(1);
    await block.getByRole('button', { name: 'Comment on line 9', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Comment on line 9' })).toBeFocused();
    await page.keyboard.insertText('Center the cost.');
    // Every diagram’s size is held, since the review can redraw again after the comment goes in, and the frame on the
    // page at the press is then a newer one. All of them go through as the press goes down.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      /** @type {MessageEvent[]} */
      const held = [];
      const hold = (/** @type {MessageEvent} */ e) => {
        if (e.data?.__pbd !== 1 || e.data.type !== 'size') return;
        held.push(e);
        e.stopImmediatePropagation();
      };
      addEventListener('message', hold, true);
      const frames = () => [...document.querySelectorAll('figure.diagram iframe')].map((f) => /** @type {HTMLIFrameElement} */ (f).contentWindow);
      w.heldFromPage = () => held.some((e) => frames().includes(/** @type {Window} */ (e.source)));
      const release = () => {
        removeEventListener('message', hold, true);
        for (const e of held) dispatchEvent(new MessageEvent('message', { data: e.data, origin: e.origin, source: e.source }));
      };
      addEventListener('pointerdown', release, { capture: true, once: true });
    });
    await page.keyboard.press('Control+Enter');
    await expect(block.locator('.g-mark[data-line="9"]'), 'the comment added').toBeFocused();
    // The redrawn frame loads as it nears the view.
    await block.locator('figure.diagram').scrollIntoViewIfNeeded();
    const submit = block.getByRole('button', { name: 'Submit review', exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => /** @type {any} */ (window).heldFromPage()), { message: 'a size held from the frame on the page now' })
      .toBe(true);
    const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await submit.boundingBox());
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: /** @type {const} */ ('left'), clickCount: 1 };
    // Sent together, so the release comes before the page draws again, as it did on CI’s runner.
    const cdp = await page.context().newCDPSession(page);
    await Promise.all([
      cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at }),
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at }),
    ]);
    await expect
      .poll(() => room.calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments, { message: 'the agent gets the comment' })
      .toEqual([{ line: 9, text: 'Center the cost.', threadId: 'you-1-1' }]);
  });
});
