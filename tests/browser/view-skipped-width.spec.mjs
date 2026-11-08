// The main pane’s size changing while you read near the end (#712a, critic’s P2 on #959). Its items off screen are
// skipped, so after a change the items that come into view draw from their estimates over the frames after. Where the
// change clamps the view to the end (the window taller than the gap), the transcript’s own hold of your place through
// those draws moved the view down to the end, and onScroll took that for you reaching it: the view followed, then took
// a new anchor. Narrowing and widening, with Work beside or the window, and growing taller and back: the view keeps
// reading, at its place: the item it reads at stays where it was. The gap to the end is recorded too, but isn’t the
// place: on a Mac the items around the view draw at heights other than x86’s and their estimates, and moved it 12 px in
// Chromium and 78 px in Firefox with the view still reading (researcher’s Mac check on d4f3ebdb).
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright's trace snapshots walk all 1,000 items with their skipped styles each action.
test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-width');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** How far the main pane’s view is from its end, and whether it reads or follows. */
const place = (page) =>
  page.evaluate(() => ({
    gap: Math.round(document.documentElement.scrollHeight - innerHeight - scrollY),
    mode: /** @type {HTMLElement} */ (document.querySelector('#main.transcript'))?.dataset.viewMode ?? '',
    anchor: /** @type {HTMLElement} */ (document.querySelector('#main.transcript'))?.dataset.viewAnchor ?? '',
    at: (() => {
      const key = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'))?.dataset.viewAnchor;
      const n = key ? document.querySelector(`#main > [data-key="${CSS.escape(key)}"]`) : null;
      return n ? Math.round(n.getBoundingClientRect().top) : null;
    })(),
  }));

/** A 1,000-item room open at that size, read up from its end by up px. */
async function readingNearEnd(page, title, { width = 1280, height = 900, up = 400 } = {}) {
  const conv = bigRoom(app, title);
  await page.setViewportSize({ width, height });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${conv.id}"] > .item`)).toHaveCount(1000, { timeout: 15_000 });
  await still(page);
  await page.evaluate((by) => scrollTo(0, document.documentElement.scrollHeight - innerHeight - by), up);
  await still(page);
  const before = await place(page);
  // It really is up from the end, and reads: a check that can fail.
  expect(before.gap, 'scrolled up from the end').toBeGreaterThanOrEqual(up - 10);
  expect(before.mode).toBe('reading');
  return { conv, before };
}

/** Each frame for 40 frames, the view’s mode, so a frame that followed is seen even if it reads again after. */
const modes = (page) =>
  page.evaluate(async () => {
    const seen = new Set();
    for (let f = 0; f < 40; f++) {
      await new Promise(requestAnimationFrame);
      seen.add(/** @type {HTMLElement} */ (document.querySelector('#main.transcript'))?.dataset.viewMode);
    }
    return [...seen];
  });

/** After the width changed and changed back: still reading, every frame, at the gap it had. */
async function keptPlace(page, before, narrowed) {
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ before, narrowed, after: await place(page) }) });
  expect(narrowed.modes, 'narrowed, each frame reading').toEqual(['reading']);
  const after = await place(page);
  expect(after.mode, 'back at its width, still reading').toBe('reading');
  expect(after.anchor, 'the item it reads at is the same').toBe(before.anchor);
  const moved = Math.abs(/** @type {number} */ (after.at) - /** @type {number} */ (before.at));
  expect(moved, `the item it reads at, ${before.at} px down before and ${after.at} px after`).toBeLessThanOrEqual(3);
}

test('#712a read 400 px up, Work opens beside the main pane and closes: the view keeps reading, at its place', async ({ page }) => {
  const { before } = await readingNearEnd(page, 'Width: Work beside');
  const width = () => page.evaluate(() => document.querySelector('#main.transcript')?.getBoundingClientRect().width);
  const wide = await width();
  await page.locator('header.topbar #work-button').click();
  await expect.poll(width, { message: 'the main pane to narrow as Work opens' }).toBeLessThan(/** @type {number} */ (wide) - 100);
  const narrowed = { modes: await modes(page), ...(await place(page)) };
  await page.locator('header.topbar #work-button').click();
  await expect.poll(width, { message: 'the main pane to widen as Work closes' }).toBe(wide);
  await still(page);
  await keptPlace(page, before, narrowed);
});

test('#712a read 400 px up, the window narrows and widens: the view keeps reading, at its place', async ({ page }) => {
  const { before } = await readingNearEnd(page, 'Width: the window');
  await page.setViewportSize({ width: 900, height: 900 });
  const narrowed = { modes: await modes(page), ...(await place(page)) };
  await page.setViewportSize({ width: 1280, height: 900 });
  await still(page);
  await keptPlace(page, before, narrowed);
});

// The two that clamp the view: the content after it shrinks by more than the gap as the window widens, or the window
// grows taller than the gap, and the items that come into view then draw from their estimates.
test('#712a read 60 px up at 900 px, the window widens and narrows: the view keeps reading, at its place', async ({ page }) => {
  const { before } = await readingNearEnd(page, 'Width: wider, near the end', { width: 900, up: 60 });
  await page.setViewportSize({ width: 1280, height: 900 });
  const narrowed = { modes: await modes(page), ...(await place(page)) };
  await page.setViewportSize({ width: 900, height: 900 });
  await still(page);
  await keptPlace(page, before, narrowed);
});

test('#712a read 400 px up, the window grows 500 px taller and back: the view keeps reading, at its place', async ({ page }) => {
  const { before } = await readingNearEnd(page, 'Height: taller');
  await page.setViewportSize({ width: 1280, height: 1400 });
  const narrowed = { modes: await modes(page), ...(await place(page)) };
  await page.setViewportSize({ width: 1280, height: 900 });
  await still(page);
  await keptPlace(page, before, narrowed);
});

// researcher's Mac check on 3c294cef: with the window taller, the view flipped to following for a frame. There the
// view reads at the end it was clamped to, and the items around it draw at heights the Mac's fonts give them, so what's
// below it shrinks and the browser clamps it again, up, at a box size already seen. Here the newest message shrinks by
// 40 px to stand in for that: a clamp moves the view up, and reaching the end yourself moves it down.
test('#712a read 400 px up, the window taller, then what’s below shrinks: the view keeps reading', async ({ page }) => {
  const { before } = await readingNearEnd(page, 'Height: taller, then a shrink');
  await page.setViewportSize({ width: 1280, height: 1400 });
  await still(page);
  expect((await place(page)).gap, 'clamped to the end, reading').toBeLessThanOrEqual(2);
  const shrunk = page.evaluate(() => {
    const items = document.querySelectorAll('#main > [data-key]');
    const last = /** @type {HTMLElement} */ (items[items.length - 1]);
    last.style.marginBottom = '-40px';
  });
  await shrunk;
  const narrowed = { modes: await modes(page), ...(await place(page)) };
  await page.setViewportSize({ width: 1280, height: 900 });
  await still(page);
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ before, narrowed, after: await place(page) }) });
  expect(narrowed.modes, 'taller, then the shrink: each frame reading').toEqual(['reading']);
  expect((await place(page)).mode, 'back at its height, still reading').toBe('reading');
});
