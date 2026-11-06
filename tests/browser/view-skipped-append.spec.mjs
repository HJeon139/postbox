// A reply arriving while the view follows the newest message moves the view once (#712a). Items off screen lay out
// at an estimate (`content-visibility: auto`, app/workbench.css), and an item appended below the view starts off
// screen. Laid out at its estimate first and at its real height a frame later, it made the following view scroll twice,
// a frame apart, so what was under the pointer moved a frame late: app-send.spec.mjs’s click on an app missed its button
// when a sent line landed under the app just before the click.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-append');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

// Far taller than the 71 px estimate, so a layout at the estimate and one at its real height scroll to different places.
const TALL = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a long reply that arrives while you follow.`).join('\n\n');

test('#712a: a reply appended while following scrolls to the end once, at its real height', async ({ page }) => {
  const { rt, store } = app;
  const t = bigRoom(app, 'Following as a reply lands', 60);
  const [se] = rt.sessionsIn(t.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(store.items(t.id).length);
  await still(page);
  await expect(page.locator(`.transcript[data-thread="${t.id}"]`)).toHaveAttribute('data-view-mode', 'following');
  // Each frame’s scroll position, from before the reply lands until well after it has drawn.
  await page.evaluate(() => {
    const tops = [scrollY];
    /** @type {any} */ (window).__tops = tops;
    const tick = () => {
      tops.push(scrollY);
      if (tops.length < 90) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const reply = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: TALL, status: 'done' });
  await expect(page.locator(`[data-key="${reply.id}"]`)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__tops.length), { timeout: 10_000 }).toBeGreaterThanOrEqual(90);
  const tops = await page.evaluate(() => /** @type {number[]} */ (/** @type {any} */ (window).__tops));
  const moves = tops.slice(1).filter((y, i) => Math.abs(y - tops[i]) >= 1).length;
  expect(moves, `the view’s scroll position, frame by frame: ${tops.join(' ')}`).toBe(1);
  const end = await page.evaluate(() => Math.abs(document.scrollingElement.scrollHeight - innerHeight - scrollY));
  expect(end, 'and it ends at the end').toBeLessThan(2);
});
