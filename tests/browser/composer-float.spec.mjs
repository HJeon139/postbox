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

/** Where the composer and its card are. */
const boxes = (page) =>
  page.evaluate(() => {
    const composer = /** @type {HTMLElement} */ (document.querySelector('.main > .composer'));
    const r = (/** @type {Element} */ el) => el.getBoundingClientRect().toJSON();
    return { composer: r(composer), card: r(/** @type {Element} */ (composer.querySelector('.composer-box'))) };
  });

for (const width of [1280, 375])
  test(`#1463 at ${width} px the card floats over the conversation, which shows and takes clicks beside and below it`, async ({ page }) => {
    await conversation(page, width);
    const look = await page.locator('.main > .composer').evaluate((el) => {
      const s = getComputedStyle(el);
      const card = getComputedStyle(/** @type {Element} */ (el.querySelector('.composer-box')));
      return { border: s.borderTopWidth, color: s.backgroundColor, image: s.backgroundImage, radius: card.borderRadius, shadow: card.boxShadow };
    });
    expect.soft(look.border, 'no border across the conversation').toBe('0px');
    expect.soft([look.color, look.image], 'no surface of its own').toEqual(['rgba(0, 0, 0, 0)', 'none']);
    expect.soft(Number.parseFloat(look.radius), 'a rounded card').toBeGreaterThanOrEqual(12);
    expect.soft(look.shadow, 'with a shadow').not.toBe('none');
    // Scrolled up, the conversation runs on under the composer: beside the card and below it, it’s what you see and
    // what a click reaches, not a band of the composer’s.
    await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2));
    await settled(page);
    const { composer, card } = await boxes(page);
    const reaches = (/** @type {number} */ x, /** @type {number} */ y) =>
      page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.transcript'), { x, y });
    expect.soft(await reaches(card.left - 4, card.top + card.height / 2), 'beside the card').toBe(true);
    expect.soft(await reaches(card.left + card.width / 2, composer.bottom - 2), 'below it').toBe(true);
    expect.soft(await reaches(card.left + card.width / 2, card.bottom + 2), 'between it and the row under it').toBe(true);
    // The space under the card is the hint’s row and a little more, less than the 30 px band it was.
    expect.soft(composer.bottom - card.bottom, 'the space under the card').toBeLessThanOrEqual(28.5);
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
