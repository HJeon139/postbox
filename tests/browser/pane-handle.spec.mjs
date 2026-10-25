// The right pane’s handle (#86): it resizes the pane by keyboard, drag and double-click, within the conversation
// column’s minimum, with axe clean on it, and its width survives a reload; a classic scroll bar doesn’t take the
// column’s room (#197); and a thread left open in a conversation opens again when you come back (#122). On the demo’s
// “Citation fixes” (tests/browser/pane.mjs). Moved from tools/check-pane-handle.mjs (#303).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { BOX_MIN, COL_MIN, fresh, go, measure, paneRoom, THREAD, WORK } from './pane.mjs';
import { failOnPageErrors, settled } from './postbox.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** @type {Awaited<ReturnType<typeof paneRoom>>} */
let room;
test.beforeAll(async () => {
  room = await paneRoom('pane-handle');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const handle = (page) => page.locator('.rp-handle');
/** Drags the handle to x, as a person does: press, two moves, release. Then waits for the layout to hold still. */
async function drag(page, x) {
  const b = await handle(page).boundingBox();
  const at = { x: b.x + b.width / 2, y: b.y + 200 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x - 20, at.y);
  await page.mouse.move(x, at.y);
  await page.mouse.up();
  await settled(page);
}
/** Opens Work in a window this wide. */
async function work(page, width) {
  await fresh(page, room, width);
  await page.locator('#work-button').click();
  await expect(page.locator(WORK)).toBeVisible();
  await settled(page);
}

// ── #86: a handle on the pane’s edge ───────────────────────────────────────────────────

test('#86 the pane’s handle resizes it by keyboard, within the column’s minimum, and the app resizes with it', async ({ page }) => {
  await work(page, 1280);
  await expect(page.locator('.transcript iframe.app-iframe'), 'the app beside Work').toBeAttached();
  await settled(page);
  const h = handle(page);
  await expect(h).toHaveAttribute('role', 'separator');
  await expect(h).toHaveAccessibleName('Resize the pane');
  for (const [attr, value] of [
    ['aria-valuenow', '440'],
    ['aria-valuemin', '320'],
    ['aria-valuemax', String(1280 - COL_MIN)],
  ])
    await expect(h).toHaveAttribute(attr, value);
  const before = await measure(page);
  await h.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(h).toHaveAttribute('aria-valuenow', '472');
  await settled(page);
  const wider = await measure(page);
  expect(wider.pane).toBe(472);
  expect(wider.app, 'the app resized with the pane').toBe(before.app - 32);
  // End takes it as wide as the column’s minimum allows, Home to its own minimum.
  await page.keyboard.press('End');
  await settled(page);
  const end = await measure(page);
  expect([end.pane, end.main]).toEqual([1280 - COL_MIN, COL_MIN]);
  await page.keyboard.press('Home');
  await settled(page);
  expect((await measure(page)).pane).toBe(320);
  // axe finds nothing wrong with it.
  await page.evaluate(`${AXE};0`);
  const bad = await page.evaluate(() =>
    /** @type {any} */ (window).axe
      .run({ include: [['.rp-handle']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
      .then((r) => r.violations.map((v) => `${v.id}: ${v.help}`)),
  );
  expect(bad).toEqual([]);
});

test('#86 a drag resizes the pane, its width survives a reload, and a double-click puts it back; at 375 px there’s no handle', async ({ page }) => {
  await work(page, 1280);
  await drag(page, 1280 - 520);
  expect((await measure(page)).pane).toBe(520);
  await page.reload();
  await expect(page.locator(WORK), 'Work, after the reload').toBeVisible();
  await settled(page);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '520');
  expect((await measure(page)).pane).toBe(520);
  await handle(page).dblclick();
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '440');
  await settled(page);
  expect((await measure(page)).pane).toBe(440);
  // At 375 px the pane covers the conversation, so it has no handle to show.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(handle(page), 'no handle at 375 px').toBeHidden();
});

test('#197 a classic scroll bar doesn’t take the column’s room, and a drag follows the pointer beside it', async ({ page }) => {
  await fresh(page, room, 985);
  // Windows, Linux, and macOS set to always show scroll bars give the page’s scroll bar 15 px of the window, which
  // innerWidth counts. Headless Chromium hides scroll bars, so the window reports those 15 px here instead.
  await page.evaluate(() => Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1000 }));
  await page.locator('#work-button').click();
  await expect(page.locator(WORK)).toBeVisible();
  await settled(page);
  const m = await measure(page);
  expect(m.main >= COL_MIN && m.box >= BOX_MIN, `the column is ${m.main} px and the text box ${m.box} px`).toBe(true);
  expect(m.pane).toBe(985 - COL_MIN);
  await drag(page, 985 - 330);
  expect((await measure(page)).pane, 'the pane’s edge follows the pointer').toBe(330);
});

// ── #122: a thread left open opens again ──────────────────────────────────────────────

test('#122 a thread left open in a conversation opens again when you come back, until you close it', async ({ page }) => {
  const thread = room.conv(`/side/${room.ids.topic}`);
  await fresh(page, room, 1280);
  await go(page, room, thread);
  await expect(page.locator(THREAD)).toBeVisible();
  await go(page, room, `#/t/${room.ids.other}`);
  await expect(page.locator('.rpane[hidden]'), 'the other conversation, alone').toHaveCount(1);
  await go(page, room, room.conv(''));
  await expect(page.locator(THREAD), 'the thread, open again').toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${thread.replace(/[/]/g, '\\/')}$`));
  // Closed, it stays closed.
  await page.locator(THREAD).getByRole('button', { name: 'Close thread' }).click();
  await expect(page.locator('.rpane[hidden]'), 'the thread closes').toHaveCount(1);
  expect(await page.evaluate(() => location.hash)).toBe(room.conv(''));
  await go(page, room, `#/t/${room.ids.other}`);
  await go(page, room, room.conv(''));
  expect(await page.evaluate(() => location.hash)).toBe(room.conv(''));
  await expect(page.locator(THREAD)).toHaveCount(0);
});

test('#122 in a window with no room for the pane, coming back opens the conversation, not the thread over it', async ({ page }) => {
  await fresh(page, room, 800);
  await go(page, room, room.conv(`/side/${room.ids.topic}`));
  await expect(page.locator('.sidepanel.pane-full'), 'the thread, full screen').toBeVisible();
  await go(page, room, `#/t/${room.ids.other}`);
  await go(page, room, room.conv(''));
  expect(await page.evaluate(() => location.hash)).toBe(room.conv(''));
  await expect(page.locator(THREAD)).toHaveCount(0);
});
