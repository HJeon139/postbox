// Where the view is in tests/browser/transcript.spec.mjs: how far it is from the end, which message it’s reading,
// and a turn of the mouse wheel over the transcript.

import { expect } from '@playwright/test';
import { settled } from './postbox.mjs';

/** How far the view is from the end of the conversation, and of the panel. */
export const gap = (page) => page.evaluate(() => Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight));
export const panelGap = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('.sp-body');
    return b ? Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) : null;
  });
/** Once the page holds still, that the view is at the end. */
export async function atTheEnd(page, what) {
  await settled(page);
  expect(await gap(page), what).toBeLessThanOrEqual(2);
}
/**
 * The message at the middle of the view, and where it starts; the same message must stay put. Where the middle falls
 * in the 12 px gap between two messages, it’s the one just below: the composer’s height (#1437) and the runner’s fonts
 * decide where a scroll lands, and a gap there is no less a view of the conversation.
 */
export const reading = (page) =>
  page.evaluate(() => {
    for (let dy = 0; dy <= 16; dy += 4) {
      const n = /** @type {HTMLElement | undefined} */ (document.elementFromPoint(760, innerHeight / 2 + dy)?.closest('.item'));
      if (n) return { key: n.dataset.key ?? '', top: Math.round(n.getBoundingClientRect().top) };
    }
    return null;
  });
export const topOf = (page, key) => page.locator(`[data-key="${key}"]`).evaluate((n) => Math.round(n.getBoundingClientRect().top));

/** Turns the mouse wheel over the middle of the transcript, as a trackpad or mouse does, and waits for the scroll to end. */
export async function wheel(page, deltaY) {
  await page.mouse.move(760, 400);
  await page.mouse.wheel(0, deltaY);
  await settled(page);
}
