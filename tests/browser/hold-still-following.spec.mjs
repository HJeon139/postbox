// Following the newest message, new content still scrolls in, but never under a button the pointer moved onto, or a
// click it has started (#1326); and a hold never hides what arrives.

import { expect, test } from '@playwright/test';
import { app, appDrawn, holdStillApp, open, PICK, ROWS, room, still, watch } from './hold-still-fixture.mjs';
import { settled, synced } from './postbox.mjs';
import { LONG } from './view-read-fixture.mjs';

holdStillApp(test, 'hold-still-following');

test('following the newest message, new content scrolls in, but not under a button the pointer moved onto or a click it started', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say } = room('Hold still: following');
  for (let i = 1; i <= 20; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  await open(page, t);
  await appDrawn(page);
  const view = () =>
    page.evaluate((id) => {
      const s = /** @type {Element} */ (document.scrollingElement);
      return {
        mode: document.querySelector(`#main.transcript[data-thread="${id}"]`)?.getAttribute('data-view-mode'),
        gap: s.scrollHeight - s.scrollTop - s.clientHeight,
      };
    }, t.id);
  expect((await view()).mode, 'the view follows the newest message').toBe('following');

  await test.step('with the pointer off the conversation, a new reply scrolls in', async () => {
    await page.mouse.move(4, 400);
    const r = say(LONG(21));
    await expect(page.locator(`[data-key="${r.id}"]`)).toBeVisible();
    await settled(page);
    expect((await view()).gap, 'at the end').toBeLessThanOrEqual(2);
  });
  const chip = page.getByRole('radio', { name: 'The corpus' });
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await chip.boundingBox());
  const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  await watch(page, pointer.x, pointer.y);

  await test.step('replies arrive while the pointer is on a button', async () => {
    for (let i = 22; i <= 24; i++) say(LONG(i));
    await synced(page, app);
    await still(page, 'replies arrive');
  });
  await test.step('a reply arrives between pressing the button and letting go, and the click lands on it', async () => {
    await page.mouse.down();
    say(LONG(25));
    await synced(page, app);
    await still(page, 'pressed');
    await page.mouse.up();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
  });
  await test.step('once the click is done, the view goes on to the newest message, with the pointer still there', async () => {
    await settled(page);
    expect(await view()).toEqual({ mode: 'following', gap: expect.any(Number) });
    expect((await view()).gap, 'at the end').toBeLessThanOrEqual(2);
  });
});

// A hold never hides what arrives (#1326’s review): inside an app’s frame the page can’t see the pointer leave or
// click, so a pointer resting on an app doesn’t hold the view while following; and while a pointer resting on a
// button holds it, the replies below count on Jump to latest, and the view goes on to them once the pointer leaves.
test('following, a pointer resting on an app doesn’t stop the view, and one resting on a button counts what arrives', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say } = room('Hold still: resting');
  for (let i = 1; i <= 20; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  await open(page, t);
  const frame = await appDrawn(page);
  const gap = () => page.evaluate(() => Math.round(document.documentElement.scrollHeight - scrollY - innerHeight));
  const pill = page.locator('.jump');
  const rest = async (/** @type {import('@playwright/test').Locator} */ on) => {
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await on.boundingBox());
    await page.mouse.move(b.x + b.width / 2, b.y + Math.min(20, b.height / 2));
  };
  const replies = async (/** @type {number} */ from) => {
    let last = null;
    for (let i = from; i < from + 5; i++) last = say(LONG(i));
    await expect(page.locator(`[data-key="${last?.id}"]`)).toBeAttached();
    await synced(page, app);
    await settled(page);
  };

  await test.step('resting on the app, five replies arrive and the view follows them', async () => {
    await rest(frame);
    await replies(100);
    expect(await gap(), 'at the end').toBeLessThanOrEqual(2);
  });
  await test.step('resting on a button, five replies arrive below it and count on Jump to latest', async () => {
    const chip = page.getByRole('radio', { name: 'The corpus' });
    await chip.scrollIntoViewIfNeeded();
    await rest(chip);
    await replies(200);
    expect(await gap(), 'held off the end').toBeGreaterThan(2);
    await expect(pill).toContainText('5 new');
  });
  await test.step('once the pointer leaves the button, the view goes on to the newest reply', async () => {
    await page.mouse.move(4, 400);
    await settled(page);
    expect(await gap(), 'at the end').toBeLessThanOrEqual(2);
    await expect(pill).toBeHidden();
  });
});

// The side panel in follow.spec.mjs’s #49 (CI run 43538589665): a pointer moved somewhere only to turn the wheel aims
// at nothing, though it rests on a button; the view following still goes on to what arrives.
test('following, a pointer that turned the wheel over a button doesn’t hold the view', async ({ page }) => {
  const { t, tools, say } = room('Hold still: wheel');
  for (let i = 1; i <= 20; i++) say(LONG(i));
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  await open(page, t);
  const chip = page.getByRole('radio', { name: 'The corpus' });
  const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await chip.boundingBox());
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 100);
  await settled(page);
  let last = null;
  for (let i = 300; i < 305; i++) last = say(LONG(i));
  await expect(page.locator(`[data-key="${last?.id}"]`)).toBeAttached();
  await synced(page, app);
  await settled(page);
  const gap = await page.evaluate(() => Math.round(document.documentElement.scrollHeight - scrollY - innerHeight));
  expect(gap, 'at the end').toBeLessThanOrEqual(2);
});
