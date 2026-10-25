// The conversation’s composer never covers what has focus (#232, WCAG 2.4.11 Focus Not Obscured). The composer
// sticks to the bottom of the window, over the end of the conversation, and the browser scrolls a control you Tab to
// only as far as the window’s edge. With the view a little above the end:
// - Tabbing through the last replies, through their buttons, a choice’s options and its Send, leaves each one in view
//   above the composer;
// - so does it while the Jump to latest pill floats above the composer;
// - Shift+Tab from the composer to the last control of the conversation does too;
// - a click on a message under the composer, which focuses it, doesn’t move the view;
// - Tabbing in a review open full screen doesn’t scroll the conversation behind it.
// At 1280 and 375 px. Each test has a conversation of its own. Moved from tools/checks/focus-clear.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('focus-clear');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A long reply, which runs on under the composer once the view is a little above the end. */
const LONG = Array.from({ length: 6 }, (_, i) => `Shelf note ${i + 1}: the 1874 Middlemarch sits with the other first editions, spine out, by the window.`);

/** A conversation with @librarian: twelve questions and answers, the long reply, then a choice. */
function conversation() {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'Focus at the foot', personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  const reply = (text) => rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 12; i++) {
    rt.addItem(t.id, { kind: 'user', text: `Question ${i}: which shelf holds the 1874 Middlemarch?` });
    reply(`Answer ${i}: the third shelf, by the window.`);
  }
  reply(LONG.join('\n\n'));
  const tools = rt.toolsFor(se.id);
  tools.show_block({
    block: {
      id: 'shelf',
      type: 'choice',
      version: 1,
      title: 'Which shelf next?',
      fallback: 'Which shelf next?',
      options: ['Third', 'Fourth', 'Fifth'].map((l) => ({ id: l.toLowerCase(), label: l })),
    },
  });
  return { t, reply, tools };
}

// frames(): focus-clear.mjs scrolls in the frame after focus moves.
const scrollY = (page) => page.evaluate(() => window.scrollY);
const composerTop = (page) => page.locator('.composer').evaluate((c) => c.getBoundingClientRect().top);
/** Whether the transcript’s messages kept their heights for two frames. */
const still = (page) =>
  page.evaluate(async () => {
    const heights = () => [...document.querySelectorAll('#main > *')].map((n) => n.getBoundingClientRect().height).join();
    const before = heights();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return heights() === before;
  });

/** Opens the conversation at its end, then scrolls up a little, so its last replies are under the composer. */
async function nearTheEnd(page, t, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.getByRole('radio', { name: 'Third' }), 'the choice’s options').toBeVisible();
  // Settled at the end: the transcript scrolls there in a frame of its own once it has drawn.
  await expect
    .poll(() => page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight - scrollY), { message: 'the view at the end' })
    .toBeLessThan(2);
  const end = await scrollY(page);
  await page.evaluate(() => scrollBy(0, -240));
  await expect.poll(() => scrollY(page), { message: 'the view 240 px above the end' }).toBe(end - 240);
  // The transcript learns you scrolled up from the scroll event, which fires in the next frame: a reply that arrives
  // before it still finds the view stuck to the end (#341).
  await frames(page);
}

/** What has focus, whether it’s in the composer, and how much of it the composer or the pill above it covers. */
const focus = (page) =>
  page.evaluate(() => {
    const a = /** @type {HTMLElement} */ (document.activeElement);
    const composer = /** @type {HTMLElement} */ (document.getElementById('composer-input')?.closest('.composer'));
    const r = a.getBoundingClientRect();
    const covered = [composer, composer.querySelector('.jump')]
      .map((n) => n?.getBoundingClientRect())
      .filter((c) => c?.height)
      .map((c) => {
        const across = Math.min(r.right, c.right) - Math.max(r.left, c.left);
        return across > 0 ? Math.max(0, Math.round(Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top))) : 0;
      });
    return {
      name: (a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 40) || a.tagName,
      inComposer: !!a.closest('.composer'),
      covered: Math.max(...covered),
    };
  });

/** Tabs from a control in the third reply from the end until focus reaches the composer, each control clear of it. */
async function tabThrough(page) {
  const from = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#main > .item')].at(-3)?.querySelector('button');
    b?.focus({ preventScroll: true });
    return !!b && document.activeElement === b;
  });
  expect(from, 'a control to start from in the third reply from the end').toBe(true);
  const seen = [];
  let f;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    f = await focus(page);
    if (f.inComposer) break;
    seen.push(f.name);
    await expect.poll(async () => (await focus(page)).covered, { message: `“${f.name}” clear of the composer and the pill` }).toBe(0);
    // No one presses Tab twice in a frame. The scroll that brought the last control clear reaches the end, and its
    // scroll event, a frame later, hides the pill: a Tab before it would land on the pill just as it hides.
    await frames(page);
  }
  expect(f?.inComposer, `Tab reached the composer, after ${seen.join(', ')}`).toBe(true);
  expect(seen.length, `controls before the composer: ${seen.join(', ')}`).toBeGreaterThanOrEqual(5);
}

for (const width of [1280, 375]) {
  test(`#232 at ${width} px: Tabbing through the last replies leaves each control in view above the composer`, async ({ page }) => {
    const { t } = conversation();
    await nearTheEnd(page, t, width);
    await tabThrough(page);
  });

  test(`#232 at ${width} px: with Jump to latest showing, Tabbing through the last replies leaves each control clear of it`, async ({ page }) => {
    const { t, reply } = conversation();
    await nearTheEnd(page, t, width);
    // A reply that arrives while you’re scrolled up brings the pill, which floats above the composer.
    reply('One more: the fourth shelf too.');
    await synced(page, app);
    await expect(page.getByRole('button', { name: /^Jump to latest/ })).toBeVisible();
    // Until the new reply has laid out: the transcript keeps what you read in place as it grows, and that can take
    // back a scroll focus-clear.mjs made in the same frame (#341).
    await expect.poll(() => still(page), { message: 'the transcript laid out' }).toBe(true);
    await tabThrough(page);
  });

  test(`#232 at ${width} px: Shift+Tab from the composer to the conversation’s last control leaves it in view`, async ({ page }) => {
    const { t } = conversation();
    await nearTheEnd(page, t, width);
    // The conversation’s last control, in the window but just under the composer: you scrolled up a little to read,
    // say. Below the window, the browser would scroll it in as far as the page goes, to the end, where it’s clear.
    // Last by position, as Shift+Tab finds it: whichever control ends the conversation is the one under test.
    const last = page.locator('#main > .item').last().getByRole('button').last();
    const under = async () => ((await last.boundingBox())?.y ?? 0) - (await composerTop(page));
    await page.evaluate((by) => scrollBy(0, by), (await under()) - 4);
    await expect.poll(async () => Math.round(await under()), { message: 'the last control 4 px under the composer' }).toBe(4);
    const box = await last.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0), 'the last control in the window').toBeLessThan(800);
    await frames(page);
    const before = await scrollY(page);
    await page.evaluate(() => document.getElementById('composer-input')?.focus({ preventScroll: true }));
    await frames(page);
    expect(await scrollY(page), 'focus in the composer left the view where it was').toBe(before);
    let f;
    for (let i = 0; i < 6 && (!f || f.inComposer); i++) {
      await page.keyboard.press('Shift+Tab');
      f = await focus(page);
    }
    await expect(last, 'Shift+Tab left the composer for the conversation’s last control').toBeFocused();
    await expect.poll(async () => (await focus(page)).covered, { message: `“${f?.name}” clear of the composer` }).toBe(0);
  });

  test(`#232 at ${width} px: a click on a message under the composer doesn’t move the view`, async ({ page }) => {
    const { t } = conversation();
    await nearTheEnd(page, t, width);
    // The long reply, scrolled so its last 40 px are under the composer, whatever the fonts make its height and the
    // blocks’ after it.
    const long = page.locator('#main > .item', { hasText: 'Shelf note 6' });
    const below = async () => ((await long.boundingBox())?.y ?? 0) + ((await long.boundingBox())?.height ?? 0) - (await composerTop(page));
    await page.evaluate((by) => scrollBy(0, by), (await below()) - 40);
    await expect.poll(async () => Math.round(await below()), { message: 'the long reply’s last 40 px under the composer' }).toBe(40);
    // A point at its edge, just above the composer.
    const box = await long.boundingBox();
    const top = await composerTop(page);
    expect(box && box.y < top - 12, 'the long reply starts above the composer').toBe(true);
    const before = await scrollY(page);
    await page.mouse.click((box?.x ?? 0) + 4, top - 6);
    await expect(long, 'the click focused the message').toBeFocused();
    await frames(page);
    expect(await scrollY(page), 'the view stayed where it was').toBe(before);
  });
}

test('#232: Tabbing in a review open full screen doesn’t scroll the conversation behind it', async ({ page }) => {
  const { t, tools } = conversation();
  tools.show_block({
    block: {
      id: 'plan',
      type: 'review',
      version: 1,
      title: 'shelves.md',
      fallback: 'The shelf plan',
      format: 'markdown',
      content: `# Shelves\n\n${Array.from({ length: 60 }, (_, i) => `- Shelf ${i + 1}: first editions.`).join('\n')}`,
    },
  });
  await nearTheEnd(page, t, 1280);
  await page.locator('.rv-full-btn').click();
  await expect(page.locator('.rv-box.rv-full'), 'the review, full screen').toBeVisible();
  const before = await scrollY(page);
  // Round the review’s controls twice: its bar sticks to the foot of the window, where the composer is behind it.
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    await frames(page);
  }
  expect(await page.evaluate(() => !!document.activeElement?.closest('.rv-full')), 'focus stayed in the full-screen review').toBe(true);
  expect(await scrollY(page), 'the conversation behind it stayed where it was').toBe(before);
});
