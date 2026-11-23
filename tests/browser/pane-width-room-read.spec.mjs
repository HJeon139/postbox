// The pane reads the window’s width each time it opens or refits, and each read of the root’s clientWidth lays out
// whatever is pending: in a long room, the transcript after a change (#619). The width changes only when the window
// or the root’s width does, so pane-width.mjs keeps it until then. Here the pane opens and closes again as the room
// grows taller, and the root’s width is read no more; then a narrower window still sends the pane full screen.

import { expect, test } from '@playwright/test';
import { fresh, paneRoom, WORK } from './pane.mjs';
import { failOnPageErrors, settled } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof paneRoom>>} */
let room;
test.beforeAll(async () => {
  room = await paneRoom('pane-width-room-read');
});
test.afterAll(async () => {
  await room?.app.stop();
});
failOnPageErrors(test);

/** Counts pane-width.mjs’s reads of the root’s clientWidth in the page, in window.__rootReads. */
const countRootReads = (page) =>
  page.addInitScript(() => {
    const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    if (!own?.get) return;
    const read = own.get;
    window.__rootReads = 0;
    Object.defineProperty(Element.prototype, 'clientWidth', {
      ...own,
      get() {
        if (this !== document.documentElement) return read.call(this);
        // The transcript reads the root’s width too, on its own scrolls and resizes: count the pane’s reads only.
        if (new Error().stack?.includes('pane-width.mjs')) window.__rootReads++;
        // A stand-in for a classic scroll bar, which headless browsers hide: the second test narrows the root by it.
        return read.call(this) - (window.__scrollBar ?? 0);
      },
    });
  });
const rootReads = (page) => page.evaluate(() => window.__rootReads);

test('#619 opening the pane again in the same window reads the window’s width no more', async ({ page }) => {
  await countRootReads(page);
  await fresh(page, room, 1280);
  const work = page.locator('#work-button');
  await work.click();
  await expect(page.locator(WORK)).toBeVisible();
  await settled(page);
  const first = await rootReads(page);
  expect(first, 'the first opening reads the width').toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) {
    await work.click();
    await expect(page.locator(WORK)).toBeHidden();
    // The room grows taller, as it does with each new item: the root’s height changes, and its width doesn’t.
    await page.evaluate(() => {
      document.querySelector('.transcript')?.append(Object.assign(document.createElement('div'), { style: 'height: 900px' }));
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    await work.click();
    await expect(page.locator(WORK)).toBeVisible();
  }
  await settled(page);
  expect(await rootReads(page), 'reads of the root’s clientWidth over three more openings, as the room grows').toBe(first);
  // A narrower window is a new width: the pane can’t fit beside the column, so Work opens full screen.
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.locator('.pane-full')).toHaveCount(1);
  expect(await rootReads(page), 'the resize read the new width').toBeGreaterThan(first);
});

test('#619 a classic scroll bar on the root is a new width, without a resize', async ({ page }) => {
  await countRootReads(page);
  await fresh(page, room, 1280);
  const work = page.locator('#work-button');
  const handle = page.locator('.rp-handle');
  await work.click();
  await expect(page.locator(WORK)).toBeVisible();
  const wide = Number(await handle.getAttribute('aria-valuemax'));
  await work.click();
  await expect(page.locator(WORK)).toBeHidden();
  // The document scrolls a long room, so on Windows and Linux a scroll bar takes width from the root as the room
  // grows: the root’s clientWidth and its box both lose it, with no resize.
  await page.evaluate(() => {
    window.__scrollBar = 40;
    document.documentElement.style.width = `${innerWidth - 40}px`;
  });
  await work.click();
  await expect(page.locator(WORK)).toBeVisible();
  await expect(handle, 'the pane’s most is 40 px less').toHaveAttribute('aria-valuemax', String(wide - 40));
});

test('#619 a width that changes as the pane opens, in the same task, is corrected once the root reports it', async ({ page }) => {
  await countRootReads(page);
  await fresh(page, room, 1280);
  const work = page.locator('#work-button');
  const handle = page.locator('.rp-handle');
  await work.click();
  await expect(page.locator(WORK)).toBeVisible();
  const wide = Number(await handle.getAttribute('aria-valuemax'));
  await work.click();
  await expect(page.locator(WORK)).toBeHidden();
  // The scroll bar shows and the pane opens in one task, as when a long room opens from a short one: the pane reads
  // the width it kept, and the root’s observer reports the new one only after the next layout.
  await page.evaluate(() => {
    window.__scrollBar = 40;
    document.documentElement.style.width = `${innerWidth - 40}px`;
    /** @type {HTMLElement} */ (document.querySelector('#work-button')).click();
  });
  await expect(page.locator(WORK)).toBeVisible();
  await expect(handle, 'the pane refits to the narrower root').toHaveAttribute('aria-valuemax', String(wide - 40));
});
