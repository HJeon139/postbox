// A scroll into a stretch of skipped items (#1257). The browser’s own scrolls, such as scrollIntoView, focus and find,
// land where the items’ estimates put things. The item across the middle of the view is then skipped too, at an
// estimate the page never showed. Taken as the anchor, it was held still while a long reply above it drew at its real
// size, which moved the page about 2.3k px and carried what the scroll had brought to the top off screen
// (view-skipped-tab.spec.mjs under lag, #1246).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, wholeRoom } from './postbox.mjs';
import { holds, open, room } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-scroll-into');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// Every item mounted, the window off: the items far from the end stay skipped at their estimates.
wholeRoom(test);

// Tall, so it draws far past its 71 px estimate.
const TALL = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the long reply.`).join('\n\n');

test('#1257: scrolled into skipped items, a long reply drawing below what’s at the top doesn’t move it off screen', async ({ page }) => {
  const { t, say } = room(app, 'Scrolled into skipped items');
  const before = app.store.state.items[t.id].at(-1);
  say(TALL);
  for (let i = 0; i < 40; i++) app.rt.addItem(t.id, { kind: 'user', text: `Note ${i} after the long reply.` });
  await open(app, page, t);
  const target = page.locator(`#main.transcript > [data-key="${before.id}"]`);
  // The long reply was never on screen: it's at its estimate until a scroll brings it near.
  expect(
    await page.evaluate((id) => {
      const n = /** @type {Element} */ (document.querySelector(`#main.transcript > [data-key="${id}"]`)?.nextElementSibling);
      return Math.round(n.getBoundingClientRect().height);
    }, before.id),
    'the long reply is at its estimate',
  ).toBe(71);

  await target.evaluate((n) => n.scrollIntoView({ block: 'start' }));
  await settled(page);
  const top = await target.evaluate((n) => n.getBoundingClientRect().top);
  expect.soft(Math.abs(top), 'what the scroll brought to the top is still there').toBeLessThanOrEqual(2);
  await holds(page, t, 'after the long reply drew');
});
