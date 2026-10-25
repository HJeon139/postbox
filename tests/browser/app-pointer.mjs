// Pointing at an agent app and clicking in it as a person does, for the app specs: a frame takes no pointer events
// until the page has seen the pointer over it (#38), so a click waits for that first.

import { expect } from '@playwright/test';
import { settled } from './postbox.mjs';

export const frameOf = (page, title) => page.locator(`iframe.app-iframe[title="${title}"]`);
/**
 * Points at an app’s big button near its frame’s top, where a message’s floating actions can’t cover it, until the page
 * sees the pointer there: a frame takes no pointer events until then (#38). A frame laying out moves, and a pointer
 * already there moves nowhere, so each try measures again and comes from off the frame.
 */
async function pointAt(page, title) {
  const f = frameOf(page, title);
  await expect(async () => {
    // First onto the sticky top bar, so no frame passes under the pointer as the page scrolls; then onto the frame
    // (forced: it takes the pointer only once the page sees it there), so its message’s actions float in first.
    await page.locator('header.topbar').hover();
    await f.evaluate((n) => n.scrollIntoView({ block: 'center' }));
    await settled(page);
    await f.hover({ force: true });
    const at = await f.evaluate((n) => {
      const b = n.getBoundingClientRect();
      const x = b.left + b.width / 2;
      for (let y = b.top + 20; y < b.top + 100; y += 10) {
        const el = document.elementFromPoint(x, y);
        if (el === n || el === n.closest('.app-body')) return { x, y };
      }
      return { x, y: b.top + 50 };
    });
    await page.mouse.move(at.x, at.y);
    await expect(f).toHaveClass(/\blive\b/, { timeout: 1000 });
  }, `${title} live under the pointer`).toPass({ timeout: 10_000 });
}
/** A real click on an app’s big button. */
export async function clickApp(page, title) {
  await pointAt(page, title);
  await page.mouse.down();
  await page.mouse.up();
}
