// Following the newest message, new content still scrolls in, but never under a button the pointer moved onto, or a
// click it has started (#1326), even one pressed in the frame the content grows (#1653); and a hold never hides what
// arrives.

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

// #1653: a quick click moves onto a button and presses it with no frame between, and content can grow before the
// next frame’s callbacks run, as a review’s diagram sized itself in WebKit: the view followed the end, the button moved
// up from under the press, and the release landed on the text below it, so the click was lost. Here the press and the
// growth come in one task, so the order holds in every browser. DRAWN (view-skip.mjs), the transcript’s synchronous
// way of hearing an item draw, stands in for whatever followed first in WebKit, which the instrumented runs didn’t
// name. Synthetic events make no click, so this checks the hold, not the click: the button stays under the press, and
// the view goes on to the end once it’s let go.
test('#1653 following, a press that comes with its move holds the button through growth before the next frame', async ({ page }) => {
  const { t, tools, say } = room('Hold still: quick press');
  for (let i = 1; i <= 20; i++) say(LONG(i));
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  await open(page, t);
  await settled(page);
  const chipTop = () => page.evaluate(() => document.querySelector('[role="radio"][aria-checked]')?.getBoundingClientRect().top ?? NaN);
  const { pressedAt, moved, at } = await page.evaluate(() => {
    const chip = /** @type {HTMLElement} */ (document.querySelector('[role="radio"][aria-checked]'));
    const r = chip.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType: 'mouse', isPrimary: true };
    chip.dispatchEvent(new PointerEvent('pointermove', at));
    chip.dispatchEvent(new PointerEvent('pointerdown', at));
    const item = /** @type {HTMLElement} */ (chip.closest('.transcript > [data-key]'));
    item.append(Object.assign(document.createElement('div'), { className: 'pb-test-grow', style: 'height: 160px' }));
    item.dispatchEvent(new Event('contentvisibilityautostatechange'));
    return { pressedAt: r.top, moved: chip.getBoundingClientRect().top - r.top, at };
  });
  expect(Math.abs(moved), `the button moved ${moved} px under the press`).toBeLessThan(1);
  await settled(page);
  expect(Math.abs((await chipTop()) - pressedAt), 'and still there once the page has drawn, while the press is held').toBeLessThan(1);
  await page.evaluate((at) => document.querySelector('[role="radio"][aria-checked]')?.dispatchEvent(new PointerEvent('pointerup', at)), at);
  await settled(page);
  const gap = await page.evaluate(() => Math.round(document.documentElement.scrollHeight - scrollY - innerHeight));
  expect(gap, 'at the end once let go').toBeLessThanOrEqual(2);
});

// The same with a real press and release, which do make a click (#1653’s symptom): the pointer rests on the button
// aiming at nothing, as after a wheel turn, so no hold is there from the move, and the item grows inside the press.
test('#1653 following, a real click lands on a button whose item grows as it’s pressed', async ({ page }) => {
  const { t, tools, say } = room('Hold still: quick click');
  for (let i = 1; i <= 20; i++) say(LONG(i));
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  await open(page, t);
  await settled(page);
  const chip = page.getByRole('radio', { name: 'The corpus' });
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await chip.boundingBox());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel')));
  await settled(page);
  await page.evaluate(() => {
    const grow = (/** @type {Event} */ e) => {
      const item = /** @type {HTMLElement} */ (/** @type {Element} */ (e.target).closest('.transcript > [data-key]'));
      item.append(Object.assign(document.createElement('div'), { className: 'pb-test-grow', style: 'height: 160px' }));
      item.dispatchEvent(new Event('contentvisibilityautostatechange'));
    };
    document.addEventListener('pointerdown', grow, { capture: true, once: true });
  });
  await page.mouse.down();
  await page.mouse.up();
  await expect(chip).toHaveAttribute('aria-checked', 'true');
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
