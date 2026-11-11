// V1 at 2× pixels (#531, B1b-a; designs/508/b1-view-state.md): the transcript's data-view-offset says where its anchor
// starts to 0.1 px, so rounding never adds to the 1 px V1 allows. Moved from view-read.spec.mjs at its length limit.
// Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox } from './postbox.mjs';
import { holds, open as openIn, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-read-2x');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const room = (/** @type {string} */ title) => roomIn(app, title);
const open = (/** @type {any} */ page, /** @type {any} */ t, width = 1280) => openIn(app, page, t, width);

test.describe('at 2× pixels', () => {
  test.use({ deviceScaleFactor: 2 });
  test('V1: the offset is published to 0.1 px, so rounding never adds to the 1 px the check allows', async ({ page }) => {
    const { t } = room('View read: offset to 0.1 px');
    await open(page, t);
    await page.evaluate(() => scrollBy(0, -1200.5));
    await settled(page);
    const v = await holds(page, t, 'reading at a half pixel');
    expect(Math.abs(/** @type {number} */ (v.actual) - Number(v.offset)), 'within 0.1 px').toBeLessThanOrEqual(0.1);
    expect(Number(v.offset) % 1, 'the scroll left the anchor on a half pixel').not.toBe(0);
  });

  // Holding the anchor scrolls by a fraction of a pixel the browser can’t land on: the view lands up to half a pixel
  // off. What’s published must be where it landed, at once, not the place it aimed for until the scroll event a frame
  // later (#1245). A reply above the anchor grows by 10.3 px, and the offset is read in the same frame, right after the
  // view’s own ResizeObserver has held the anchor.
  test('V1: a hold that can’t land on its fraction of a pixel publishes where it landed (#1245)', async ({ page }) => {
    const { t } = room('View read: a hold off the pixel');
    await open(page, t);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -1200);
    await settled(page);
    const before = await holds(page, t, 'reading');
    const got = await page.evaluate(
      (threadId) =>
        new Promise((done) => {
          const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
          const anchor = () => /** @type {Element} */ (el.querySelector(`:scope > [data-key="${CSS.escape(String(el.dataset.viewAnchor))}"]`));
          const above = /** @type {HTMLElement} */ (anchor().previousElementSibling);
          // Made after the view’s, so it runs after it in the same frame, before any scroll event.
          const after = new ResizeObserver(() => {
            after.disconnect();
            done({ key: el.dataset.viewAnchor, offset: Number(el.dataset.viewOffset), actual: anchor().getBoundingClientRect().top });
          });
          after.observe(el);
          above.style.paddingBottom = '10.3px';
        }),
      t.id,
    );
    expect(got.key, 'the same anchor').toBe(before.anchor);
    expect(Math.abs(got.actual - got.offset), 'published where it landed, within 0.1 px').toBeLessThanOrEqual(0.1);
  });
});
