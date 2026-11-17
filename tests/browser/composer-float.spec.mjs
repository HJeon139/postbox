// The conversation’s composer floats over the end of the conversation as a card (#1463): no band across the window and
// no border over the transcript, which runs on under it, and its last message still scrolls clear above the card, at
// 1280 and 375 px.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-float');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A conversation with @librarian, long enough to scroll, ending on a reply, open at the given width. */
async function conversation(page, width) {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: `Float ${++count}`, personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  for (let i = 1; i <= 15; i++) {
    arrange.post(rt, t.id, { kind: 'user', text: `Question ${i}: which shelf holds the 1874 Middlemarch?` });
    arrange.post(rt, t.id, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      text: `Answer ${i}: the third shelf, by the window.`,
      status: 'done',
    });
  }
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('.transcript').getByText('Answer 15:')).toBeVisible();
  await settled(page);
  return t;
}

/** Where the composer and its card are, and what is drawn at a point. */
const boxes = (page) =>
  page.evaluate(() => {
    const composer = /** @type {HTMLElement} */ (document.querySelector('.main > .composer'));
    const r = (/** @type {Element} */ el) => el.getBoundingClientRect().toJSON();
    return { composer: r(composer), card: r(/** @type {Element} */ (composer.querySelector('.composer-box'))), style: getComputedStyle(composer) };
  });

for (const width of [1280, 375])
  test(`#1463 at ${width} px the composer is a card over the conversation, with no band or border across it`, async ({ page }) => {
    await conversation(page, width);
    const look = await page.locator('.main > .composer').evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        border: s.borderTopWidth,
        color: s.backgroundColor,
        image: s.backgroundImage,
        card: getComputedStyle(/** @type {Element} */ (el.querySelector('.composer-box'))).borderRadius,
      };
    });
    expect.soft(look.border, 'no border across the conversation').toBe('0px');
    // Not a band of its own: transparent at its top edge, so the conversation fades under it rather than stopping at a line.
    expect.soft(look.color, 'no flat background').toBe('rgba(0, 0, 0, 0)');
    expect.soft(look.image, 'a fade at its top edge').toMatch(/^linear-gradient\(/);
    expect.soft(Number.parseFloat(look.card), 'a rounded card').toBeGreaterThanOrEqual(12);
    // The conversation runs on under it: scrolled up, a message lies beneath the composer’s top edge.
    await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2));
    await settled(page);
    const { composer } = await boxes(page);
    const under = await page.locator('.transcript > .item').evaluateAll(
      (items, top) =>
        items.some((el) => {
          const b = el.getBoundingClientRect();
          return b.top < top && b.bottom > top;
        }),
      composer.top,
    );
    expect.soft(under, 'a message runs under the composer').toBe(true);
  });

for (const width of [1280, 375])
  test(`#1463 at ${width} px the last message scrolls clear above the floating card`, async ({ page }) => {
    await conversation(page, width);
    // Up and back to the end, as a person scrolls.
    await page.evaluate(() => window.scrollTo(0, 0));
    await settled(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settled(page);
    const last = page.locator('.transcript > .item').last();
    await expect(last).toContainText('Answer 15:');
    const { composer, card } = await boxes(page);
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await last.boundingBox());
    expect.soft(b.y + b.height, 'its end is above the card').toBeLessThanOrEqual(card.y);
    expect.soft(b.y + b.height, 'and above where the composer starts to cover it').toBeLessThanOrEqual(composer.y + 0.5);
    // Nothing is drawn over its last line.
    const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.transcript'), { x: b.x + 20, y: b.y + b.height - 4 });
    expect.soft(hit, 'its last line is on top').toBe(true);
  });
