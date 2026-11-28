// The gear on the buttons that open a conversation’s or the room’s settings (Manage, the Agents heading’s, Permissions…).
// It was drawn as a circle with eight rays, which reads as a sun, so a person looking for settings didn’t find it there.
// It is a gear: one closed outline with teeth around a hole. Every button that asks for icon('gear') draws the same.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('gear-icon');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** The drawing an icon is masked with, as the page computes it. @param {import('@playwright/test').Locator} icon */
const drawing = (icon) => icon.evaluate((el) => decodeURIComponent(getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage));

test('the Manage buttons draw a gear, a toothed outline around a hole, not a circle with rays', async ({ page }) => {
  const room = Object.values(app.rt.s.threads).find((/** @type {any} */ t) => t.title === 'Asset explorer');
  await page.goto(`${app.origin}/#/t/${/** @type {any} */ (room).id}`);
  await synced(page, app);
  const gears = [page.locator('#conversation-actions .i'), page.getByRole('button', { name: 'Manage this conversation’s members' }).locator('.i')];
  for (const gear of gears) {
    await expect(gear).toBeVisible();
    const svg = await drawing(gear);
    // One outline of 32 corners, 4 for each of 8 teeth, closed, and a hole in the middle.
    const outline = /<path d='M([^']+)Z'/.exec(svg)?.[1] ?? '';
    expect(outline.split('L')).toHaveLength(32);
    expect(svg).toContain("<circle cx='8' cy='8' r='2'");
    // No ray: a line drawn alone from near the middle outward, as the sun’s were.
    expect(svg).not.toMatch(/M[\d.]+ [\d.]+[vh]-?[\d.]+/);
  }
});
