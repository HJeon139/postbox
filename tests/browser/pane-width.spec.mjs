// How the right pane shares the window with the conversation, at 800, 1024 and 1280 px with the sidebar open: the
// column and the composer’s text box keep their minimums or the view opens full screen, and a wider window puts the
// pane back (#197); and the sidebar hides first, while the pane needs its room (#7). pane-handle.spec.mjs checks the
// pane’s handle (#86) and a thread left open (#122). On the demo’s “Citation fixes” (tests/browser/pane.mjs). Moved
// from tools/check-pane-width.mjs (#303).

import { expect, test } from '@playwright/test';
import { BOX_MIN, COL_MIN, fresh, go, measure, paneRoom, THREAD, WORK } from './pane.mjs';
import { failOnPageErrors, settled } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof paneRoom>>} */
let room;
test.beforeAll(async () => {
  room = await paneRoom('pane-width');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const rail = (page) => page.evaluate(() => localStorage.getItem('pb-rail'));

// ── #197: the column keeps its minimum, or the view opens full screen ──────────────────

for (const [view, how, sel] of [
  ['Work', (page) => page.locator('#work-button').click(), WORK],
  ['the thread', (page) => go(page, room, room.conv(`/side/${room.ids.topic}`)), THREAD],
])
  for (const width of [800, 1024, 1280])
    test(`#197 at ${width} px with the sidebar open, ${view} leaves the column and the text box usable, or opens full screen`, async ({ page }) => {
      await fresh(page, room, width);
      const before = await measure(page);
      await how(page);
      await expect(page.locator(sel)).toBeVisible();
      await settled(page);
      const m = await measure(page);
      const kept = m.main >= COL_MIN && m.box >= BOX_MIN && m.pane >= 320;
      expect(
        m.full || kept,
        `the column is ${m.main} px (a reply ${m.reply} px), the text box ${m.box} px, the pane ${m.pane} px, and nothing is full screen`,
      ).toBe(true);
      if (!m.full) return;
      // Full screen, the view is the window and a dialog, and the address still says only what’s open.
      expect(m.focusIn, 'focus is in the full-screen view').toBe(true);
      expect(await page.evaluate(() => location.hash)).not.toMatch(/full=/);
      // Its icon goes back to the conversation, since there’s no pane to go back to, and says so.
      await expect(page.locator('.pane-full').getByRole('button', { name: 'Back to the conversation', exact: true })).toBeVisible();
      // Escape brings the conversation back.
      await page.keyboard.press('Escape');
      await expect(page.locator('.pane-full')).toHaveCount(0);
      await expect(page.locator('.rpane[hidden]'), 'the pane closed').toHaveCount(1);
      expect(await page.evaluate(() => location.hash)).toBe(room.conv(''));
      await settled(page);
      const back = await measure(page);
      expect([back.main, back.box], 'the conversation comes back as it was').toEqual([before.main, before.box]);
    });

test('#197 a wider window puts the pane back beside the conversation, since what’s open stays in the address', async ({ page }) => {
  await fresh(page, room, 800);
  await page.locator('#work-button').click();
  await expect(page.locator('.workpane.pane-full'), 'Work full screen at 800 px').toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(room.conv('?work'));
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('.pane-full')).toHaveCount(0);
  await expect(page.locator(WORK), 'Work beside the conversation at 1440 px').toBeVisible();
  await settled(page);
  const m = await measure(page);
  expect(m.main >= COL_MIN && m.pane >= 320, `the column is ${m.main} px and the pane ${m.pane} px`).toBe(true);
  // And narrower again, full screen again.
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.locator('.workpane.pane-full'), 'Work full screen again at 800 px').toBeVisible();
  await expect(page.locator(`${WORK}:not(.pane-full)`)).toHaveCount(0);
});

// ── #7: the sidebar hides first, while the pane needs its room ─────────────────────────

test('#7 at 1280 px, a thread hides the sidebar while it’s open, so an app keeps its room, and closing it brings the sidebar back', async ({ page }) => {
  await fresh(page, room, 1280);
  await expect(page.locator('.transcript iframe.app-iframe'), 'the app').toBeAttached();
  await settled(page);
  const before = await measure(page);
  expect(before.rail).toBe(248);
  await go(page, room, room.conv(`/side/${room.ids.topic}`));
  await expect(page.locator(THREAD)).toBeVisible();
  await settled(page);
  const m = await measure(page);
  expect([m.rail, m.auto, m.pane, m.toggle], 'the sidebar hides for the pane').toEqual([0, true, 440, 'Show the sidebar']);
  // #7 measured an app at about 590 px beside the pane with the sidebar open.
  expect(m.app, 'the app keeps its room').toBeGreaterThan(700);
  await page.locator(THREAD).getByRole('button', { name: 'Close thread' }).click();
  await expect(page.locator('.rpane[hidden]'), 'the thread closes').toHaveCount(1);
  await settled(page);
  const back = await measure(page);
  expect([back.rail, back.auto, back.toggle, back.app], 'the sidebar comes back').toEqual([248, false, 'Hide the sidebar', before.app]);
  expect(await rail(page), 'what the person chose didn’t change').toBe(null);
});

test('#7 showing the sidebar again while the pane is open keeps it, and the pane makes do with what’s left', async ({ page }) => {
  await fresh(page, room, 1280);
  await page.locator('#work-button').click();
  await expect(page.locator(WORK)).toBeVisible();
  await expect(page.locator('.app.rail-auto'), 'the sidebar hidden').toHaveCount(1);
  await page.locator('#rail-toggle').click();
  await expect(page.locator('.app.rail-auto'), 'the sidebar back').toHaveCount(0);
  await settled(page);
  const m = await measure(page);
  expect([m.rail, m.toggle, m.full]).toEqual([248, 'Hide the sidebar', false]);
  expect(m.main >= COL_MIN && m.pane === 1280 - 248 - COL_MIN, `the column is ${m.main} px and the pane ${m.pane} px`).toBe(true);
});

test('#7 from a sidebar the person hid, showing it while the pane is open shows it at once, and keeps it', async ({ page }) => {
  await fresh(page, room, 1280, { railHidden: true });
  await page.locator('#work-button').click();
  await expect(page.locator(WORK)).toBeVisible();
  await settled(page);
  expect((await measure(page)).rail).toBe(0);
  await page.locator('#rail-toggle').click();
  await settled(page);
  const m = await measure(page);
  expect([m.rail, m.auto, m.toggle], 'one press shows the sidebar').toEqual([248, false, 'Hide the sidebar']);
  expect(m.main >= COL_MIN && m.pane === 1280 - 248 - COL_MIN, `the column is ${m.main} px and the pane ${m.pane} px`).toBe(true);
  expect(await rail(page)).toBe('shown');
});

for (const railHidden of [false, true])
  test(`#7 where the pane wouldn’t fit beside the sidebar${railHidden ? ' the person hid' : ''}, the button says it can’t show it, and changes nothing`, async ({
    page,
  }) => {
    await fresh(page, room, 1024, { railHidden });
    await page.locator('#work-button').click();
    await expect(page.locator(WORK)).toBeVisible();
    await expect(page.locator('#rail-toggle')).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled: it takes the click, to say why it can’t show the sidebar. Playwright would wait for it
    // to be enabled, so the click skips that wait; it’s still the mouse’s.
    await page.locator('#rail-toggle').click({ force: true });
    await expect(page.locator('.toast', { hasText: 'No room for the sidebar beside the pane' }), 'why it can’t show').toBeVisible();
    await settled(page);
    const m = await measure(page);
    expect([m.full, m.rail, m.toggle], 'the pane stays, and the sidebar doesn’t show over it').toEqual([false, 0, 'Show the sidebar']);
    expect(m.main, 'the column keeps its minimum').toBeGreaterThanOrEqual(COL_MIN);
    expect(await rail(page), 'what the person chose didn’t change').toBe(railHidden ? 'hidden' : null);
  });

test('#7 leaving a conversation whose pane hid the sidebar, the next one shows it, and its button says so', async ({ page }) => {
  await fresh(page, room, 1280);
  await go(page, room, room.conv(`/side/${room.ids.topic}`));
  await expect(page.locator(THREAD)).toBeVisible();
  await expect(page.locator('.app.rail-auto'), 'the sidebar hidden').toHaveCount(1);
  await go(page, room, `#/t/${room.ids.other}`);
  await expect(page).toHaveURL(new RegExp(`#/t/${room.ids.other}$`));
  await settled(page);
  const m = await measure(page);
  expect([m.rail, m.toggle]).toEqual([248, 'Hide the sidebar']);
  await expect(page.locator('#rail-toggle')).toHaveAttribute('aria-pressed', 'true');
});
