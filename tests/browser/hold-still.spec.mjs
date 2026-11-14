// What you read or point at holds still while agents work (#1326). The person read mid-room, an agent’s update moved
// the page, and their click landed on something else. Agents stream replies, update blocks, and their apps and images
// grow, above the view and inside it; through all of it the element under a fixed point of the view, and the button
// under the pointer, stay where they were, within a pixel. Following: hold-still-following.spec.mjs.

import { expect, test } from '@playwright/test';
import { app, appDrawn, growApp, holdStillApp, open, PICK, PICTURE, ROWS, room, scrollTo, still, stream, watch } from './hold-still-fixture.mjs';
import { synced } from './postbox.mjs';
import { LONG } from './view-read-fixture.mjs';

holdStillApp(test, 'hold-still');

test('reading mid-room, what’s at the middle of the view holds still while agents stream, update and grow blocks around it', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say, streaming } = room('Hold still: reading');
  for (let i = 1; i <= 5; i++) say(LONG(i));
  const live = streaming();
  for (let i = 6; i <= 8; i++) say(LONG(i));
  const reviewId = `notes-${t.id}`;
  const review = { id: reviewId, type: 'review', version: 1, title: 'notes.md', fallback: 'Notes', format: 'markdown', content: '# Notes\n\nOne line.' };
  tools.show_block({ block: review });
  for (let i = 9; i <= 10; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  const picture = `${app.origin}/media/hold-still-${t.id}.svg`;
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(undefined);
  });
  await page.route(picture, async (route) => {
    await held;
    await route.fulfill({ contentType: 'image/svg+xml', body: PICTURE });
  });
  const read = say(`${LONG(11)}\n\n![The chart](${picture})\n\nAfter the chart: the claims hold for every source we read.`);
  for (let i = 12; i <= 30; i++) say(LONG(i));
  await open(page, t);
  // The paragraph after the picture across the middle, the app above it in view, and the pointer off the conversation.
  const after = page.locator(`[data-key="${read.id}"] p`, { hasText: 'After the chart' });
  await scrollTo(page, after, 390);
  await appDrawn(page);
  await scrollTo(page, after, 390);
  await page.mouse.move(4, 400);
  const x = await after.evaluate((n) => n.getBoundingClientRect().left + 40);
  await watch(page, x, 400);
  const at = await page.evaluate(([x]) => document.elementFromPoint(x, 400)?.textContent ?? '', [x]);
  expect(at, 'the point is on the paragraph after the picture').toContain('After the chart');

  await test.step('a reply streams above the view', async () => {
    await stream(page, t, live, 100, 20);
    await still(page, 'stream above');
  });
  await test.step('the review above is revised, and moves to the end', async () => {
    tools.update_block({ block: { ...review, content: `# Notes\n\n${'A longer line.\n\n'.repeat(20)}`, previous: review.content } });
    await synced(page, app);
    await still(page, 'review moved');
  });
  await test.step('the app above the point grows', async () => {
    await growApp(page, 12);
    await still(page, 'app grows');
  });
  await test.step('the picture above the point loads', async () => {
    release();
    await expect.poll(() => page.locator(`[data-key="${read.id}"] img.md-img`).evaluate((n) => /** @type {HTMLImageElement} */ (n).naturalHeight)).toBe(240);
    await still(page, 'picture loads');
  });
  await test.step('agents post below', async () => {
    for (let i = 31; i <= 33; i++) say(LONG(i));
    await synced(page, app);
    await still(page, 'posts below');
  });
});

test('reading, a button under the pointer stays under it while a block above it grows, and the click lands on it', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say, streaming } = room('Hold still: pointer');
  for (let i = 1; i <= 5; i++) say(LONG(i));
  const live = streaming();
  for (let i = 6; i <= 10; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  for (let i = 11; i <= 30; i++) say(LONG(i));
  await open(page, t);
  const chip = page.getByRole('radio', { name: 'The claims' });
  // The app across the middle, and the button below it.
  const frame = page.locator('iframe.app-iframe[title="Results"]');
  await scrollTo(page, frame, 300);
  await appDrawn(page);
  await scrollTo(page, frame, 300);
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await chip.boundingBox());
  const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(pointer.y, 'the button is in view').toBeLessThan(780);
  await page.mouse.move(pointer.x, pointer.y);
  await watch(page, pointer.x, pointer.y);

  await test.step('a reply streams above the view', async () => {
    await stream(page, t, live, 100, 12);
    await still(page, 'stream above');
  });
  await test.step('the app above the button grows', async () => {
    await growApp(page, 12);
    await still(page, 'app grows');
  });
  await test.step('the click lands on the button', async () => {
    await page.mouse.down();
    await page.mouse.up();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
  });
});
