// The thread panel’s composer floats as the conversation’s does (#1463 there, #1500 here): a card over the end of the
// panel’s transcript, with no border or band across the panel, so the thread shows beside and below the card and takes
// clicks there, and its last message still scrolls clear above the card.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-float-panel');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A conversation with a topic thread long enough to scroll, open in the thread panel at the given width. */
async function panel(page, width) {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.keys(store.state.projects)[0], title: `Panel ${++count}`, personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  const said = arrange.post(rt, t.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: 'The shelves are sorted.',
    status: 'done',
  });
  const { threadId } = rt.startTopic(t.id, said.id);
  for (let i = 1; i <= 15; i++) arrange.post(rt, threadId, { kind: 'user', text: `Note ${i}: the 1874 Middlemarch is on the third shelf, by the window.` });
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${threadId}`);
  await synced(page, app);
  await expect(page.locator('.sidepanel .transcript').getByText('Note 15:')).toBeVisible();
  await settled(page);
}

/** Where the panel’s composer and its card are. */
const boxes = (page) =>
  page.evaluate(() => {
    const composer = /** @type {HTMLElement} */ (document.querySelector('.sidepanel .composer'));
    const r = (/** @type {Element} */ el) => el.getBoundingClientRect().toJSON();
    return { composer: r(composer), card: r(/** @type {Element} */ (composer.querySelector('.composer-box'))) };
  });
/**
 * Whether a click at x, y reaches the thread: its transcript, or the scroll box around it (whose 14 px gutter is beside
 * the card on a phone), and nothing of the composer.
 */
const reaches = (page, x, y) =>
  page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit?.closest('.sidepanel .sp-body') && !hit.closest('.composer, .sp-foot');
    },
    { x, y },
  );
/** Whether the panel’s transcript itself is what a click at x, y reaches. */
const inTranscript = (page, x, y) => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.sidepanel .transcript'), { x, y });
/** Scrolls the panel’s transcript to a share of the way down, and waits for it to hold still. */
async function scrollTo(page, share) {
  await page.locator('.sidepanel .sp-body').evaluate((el, share) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * share;
  }, share);
  await settled(page);
}

for (const width of [1280, 375])
  test(`#1500 at ${width} px the thread panel’s card floats over its transcript, which shows and takes clicks beside and below it`, async ({ page }) => {
    await panel(page, width);
    const look = await page.locator('.sidepanel .composer').evaluate((el) => {
      const foot = getComputedStyle(/** @type {Element} */ (el.closest('.sp-foot')));
      const s = getComputedStyle(el);
      const card = getComputedStyle(/** @type {Element} */ (el.querySelector('.composer-box')));
      return { border: foot.borderTopWidth, surface: [s.backgroundColor, foot.backgroundColor], radius: card.borderRadius, shadow: card.boxShadow };
    });
    expect.soft(look.border, 'no border across the panel').toBe('0px');
    expect.soft(look.surface, 'no surface of its own').toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
    expect.soft(Number.parseFloat(look.radius), 'a rounded card').toBeGreaterThanOrEqual(12);
    expect.soft(look.shadow, 'with a shadow').not.toBe('none');
    await scrollTo(page, 0.5);
    const { composer, card } = await boxes(page);
    expect.soft(await reaches(page, card.left - 4, card.top + card.height / 2), 'beside the card').toBe(true);
    expect.soft(await inTranscript(page, card.left + card.width / 2, composer.bottom - 2), 'below it, the thread itself').toBe(true);
  });

for (const width of [1280, 375])
  test(`#1500 at ${width} px the thread panel’s last message scrolls clear above the floating card`, async ({ page }) => {
    await panel(page, width);
    await scrollTo(page, 0);
    await scrollTo(page, 1);
    const last = page.locator('.sidepanel .transcript > .item').last();
    await expect(last).toContainText('Note 15:');
    const { card } = await boxes(page);
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await last.boundingBox());
    expect.soft(b.y + b.height, 'its end is above the card').toBeLessThanOrEqual(card.y);
    expect.soft(await inTranscript(page, b.x + 20, b.y + b.height - 4), 'its last line is on top').toBe(true);
  });
