// Jump to latest over skipped items (#712a): the pill scrolls smoothly to the end of the main pane. The items it passes
// draw for the first time on the way down (`content-visibility: auto`, app/workbench.css), and each draw re-applies the
// view (app/js/view-state.mjs). While the jump runs, that mustn't snap the view to the end, and when it ends short of a
// page that grew as it drew, it goes the rest of the way. A wheel up during it is you reading. Each test has a
// conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright's trace snapshots walk all 1,000 items with their skipped styles each action, which
// takes longer than the test.
test.use({ colorScheme: 'light', trace: 'off', reducedMotion: 'no-preference' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-smooth');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/**
 * A 1,000-item room, open and read from its top, with a reply since, so the pill shows: everything between the top
 * and the end has never drawn.
 */
async function readingAtTop(page, title) {
  const conv = bigRoom(app, title);
  const [se] = app.rt.sessionsIn(conv.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${conv.id}"] > .item`)).toHaveCount(1000, { timeout: 15_000 });
  await still(page);
  // A wheel turn up, so the view reads; then straight to the top, since Firefox moves about 1,500 px a turn. The top is
  // held for 30 frames before the jump, so no wheel scroll still landing is taken for one during it. The turn is over
  // the top bar, as view-skipped-tab.spec.mjs’s is: over the room, an item that scrolls itself, a code block or a
  // table, could take all of it, and the view stayed following (CI, 2 of 60).
  await page.locator('header.topbar').hover();
  await page.mouse.wheel(0, -2000);
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-view-mode', 'reading', { timeout: 15_000 });
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.evaluate(heldAtTop), { message: 'the view to hold at the top for 30 frames', timeout: 15_000 }).toBe(true);
  await still(page);
  const reply = app.rt.addItem(conv.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    text: 'A reply since.',
    status: 'done',
  });
  // With the server's events late and ten of these rooms at once, the reply took over 5 s to reach the page. In CI's
  // late shard the pill didn't show in 15 s on every head from d4f3ebdb: the message says whether the reply had come,
  // and how the view read, so the next run names the cause.
  const state = () =>
    page.evaluate((key) => {
      const t = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
      return { mode: t?.dataset.viewMode, items: t?.children.length, replyHere: !!document.querySelector(`[data-key="${key}"]`), scrollY };
    }, reply.id);
  await expect(page.locator('.jump'))
    .toBeVisible({ timeout: 15_000 })
    .catch(async (e) => {
      throw new Error(`${e.message}\nthe page when the check gave up: ${JSON.stringify(await state())}`);
    });
}

// How far back scrollY may step as the page settles near the end: a line of text at the usual size. Firefox on a Mac
// stepped back 2–8 px, and Chromium on CI too, both with the view ending following at the end. What this guards is the
// view turning back, which was hundreds to thousands of px (a late wheel turn, the jump read as your scroll). Every
// step back is listed in the measured line (`back`) whatever its size.
const SETTLES = 16;

/** In the page: whether scrollY stays under 2,000 and unchanged for 30 frames. */
function heldAtTop() {
  return new Promise((done) => {
    const y = scrollY;
    let n = 0;
    const tick = () => {
      if (scrollY !== y || y >= 2000) return done(false);
      if (++n >= 30) return done(true);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Records scrollY every frame from now until it has held for 30 frames, or 10 s. */
const record = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.smoothYs = [scrollY];
    w.smoothHs = [document.documentElement.scrollHeight];
    w.smoothDone = new Promise((done) => {
      let calm = 0;
      const end = performance.now() + 10_000;
      const tick = () => {
        const ys = w.smoothYs;
        ys.push(scrollY);
        w.smoothHs.push(document.documentElement.scrollHeight);
        calm = ys.at(-1) === ys.at(-2) ? calm + 1 : 0;
        if ((calm >= 30 && ys.at(-1) !== ys[0]) || performance.now() > end) done(ys);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).smoothDone);
/** Each frame where scrollY went back up: where from and to, and the page's height in the frame before and in it. */
const backSteps = (page) =>
  page.evaluate(() => {
    const { smoothYs: ys, smoothHs: hs } = /** @type {any} */ (window);
    return ys.flatMap((/** @type {number} */ y, /** @type {number} */ i) =>
      i && y < ys[i - 1] ? [{ frame: i, from: ys[i - 1], to: y, heightBefore: hs[i - 1], height: hs[i] }] : [],
    );
  });
const gap = (page) => page.evaluate(() => document.documentElement.scrollHeight - scrollY - innerHeight);

// Items shorter than their estimate, as the Mac’s fonts draw them, as well as at their usual size (view-jump.spec.mjs):
// on the Mac, Chromium’s scrollY went back up once on the way down.
for (const [sizes, css] of [
  ['their usual size', ''],
  ['shorter than their estimate', '.transcript .item { line-height: 1.05 !important; font-size: 12px !important }'],
  ['far shorter than their estimate', '.transcript .item { line-height: 0.9 !important; font-size: 8px !important }'],
])
  test(`Jump to latest over 1,000 skipped items at ${sizes} scrolls smoothly, and ends following at the end`, async ({ page }) => {
    if (css)
      await page.addInitScript((rule) => {
        addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: rule })));
      }, css);
    await readingAtTop(page, `Smooth jump, items at ${sizes}`);
    await record(page);
    await page.locator('.jump').getByRole('button').click();
    const ys = /** @type {number[]} */ (await recorded(page));
    await still(page);
    const steps = ys.slice(1).map((y, i) => y - ys[i]);
    const distance = /** @type {number} */ (ys.at(-1)) - ys[0];
    const v = {
      frames: ys.length,
      distinct: new Set(ys).size,
      distance,
      biggest: Math.max(...steps),
      backwards: steps.filter((d) => d < -SETTLES).length,
      mode: await page.locator('#main.transcript').getAttribute('data-view-mode'),
      gap: await gap(page),
      back: await backSteps(page),
    };
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
    expect.soft(v.distinct, 'scrollY takes many values on the way down').toBeGreaterThan(5);
    expect.soft(v.backwards, `scrollY never goes back up by more than ${SETTLES} px`).toBe(0);
    expect.soft(v.biggest, 'no one frame jumps more than 60% of the way').toBeLessThanOrEqual(0.6 * distance);
    expect.soft(v.mode, 'it ends following').toBe('following');
    expect.soft(v.gap, 'it ends at the end').toBeLessThanOrEqual(2);
  });

test('a wheel up during the jump is you reading: the view stays where you turned it, not dragged to the end', async ({ page, browserName }) => {
  await readingAtTop(page, 'Smooth jump, then a wheel up');
  await page.locator('.jump').getByRole('button').click();
  // Partway down, and still moving. Chromium ends the jump on the wheel turn, and drops the turn's own scroll.
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -400);
  await still(page);
  const v = { mode: await page.locator('#main.transcript').getAttribute('data-view-mode'), gap: await gap(page) };
  // Firefox didn’t always stop its smooth scroll for the test’s wheel turn: the scroll went on to the end, where reading
  // and following are the same place. There it’s recorded, not judged; whether a real wheel stops it isn’t known.
  const stopped = browserName !== 'firefox' || v.gap > 2;
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ ...v, stopped }) });
  if (!stopped) return;
  expect.soft(v.mode, 'it reads where you turned the wheel').toBe('reading');
  expect.soft(v.gap, 'it isn’t at the end').toBeGreaterThan(400);
});

// A click or a key that can’t scroll the page doesn’t stop the jump, so it isn’t you reading: starting a reply while
// the jump runs leaves it to go the rest of the way and follow (app/js/view-smooth.mjs). Two cases, so a click and a
// key are told apart: a click into the composer, and typing into it after a focus that no input made.
for (const [how, act] of /** @type {const} */ ([
  ['a click into the composer', (page) => page.locator('#composer-input').click()],
  [
    'typing into the composer',
    async (page) => {
      await page.locator('#composer-input').evaluate((n) => /** @type {HTMLElement} */ (n).focus({ preventScroll: true }));
      await page.keyboard.type('a reply, with spaces');
    },
  ],
]))
  test(`${how} during the jump isn’t you reading: it still ends following at the end`, async ({ page }) => {
    await readingAtTop(page, `Smooth jump, then ${how}`);
    await page.locator('.jump').getByRole('button').click();
    await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
    await act(page);
    await still(page);
    const v = { mode: await page.locator('#main.transcript').getAttribute('data-view-mode'), gap: await gap(page) };
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
    expect.soft(v.mode, 'it ends following').toBe('following');
    expect.soft(v.gap, 'it ends at the end').toBeLessThanOrEqual(2);
  });

// A jump to an item while the smooth jump to the end runs, as Needs you or a thread’s link makes: the item is where
// you went, and the view reads there. Without the jump ending it, the smooth scroll went on to the end, since a jump
// isn’t input that can scroll; and Chromium applies one more step of a smooth scroll a frame after it ends.
test('a jump to an item during the jump to the end lands on that item, reading', async ({ page }) => {
  await readingAtTop(page, 'Smooth jump, then a jump to an item');
  await page.locator('.jump').getByRole('button').click();
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
  // The smooth scroll’s scrollend is heard three frames late, after the jump has put its item back, as a busy page may
  // hear it: a capturing listener holds it, then sends it on. Then each frame for half a second, how close the view
  // came to the end. Without halt() ending the smooth jump, that late scrollend takes the view the rest of the way.
  const { key, closest } = await page.evaluate(async () => {
    const { jumpTo } = await import('/app/js/view-jump.mjs');
    const item = /** @type {HTMLElement} */ (document.querySelectorAll('#main > [data-key]')[700]);
    const frame = () => new Promise(requestAnimationFrame);
    const hold = (/** @type {Event} */ e) => {
      if (!e.isTrusted) return;
      e.stopImmediatePropagation();
      removeEventListener('scrollend', hold, true);
      void frame()
        .then(frame)
        .then(frame)
        .then(() => document.dispatchEvent(new Event('scrollend', { bubbles: true })));
    };
    addEventListener('scrollend', hold, true);
    jumpTo(item);
    const gaps = [];
    for (let f = 0; f < 30; f++) {
      await frame();
      gaps.push(document.documentElement.scrollHeight - innerHeight - scrollY);
    }
    return { key: item.dataset.key, closest: Math.round(Math.min(...gaps)) };
  });
  await still(page);
  const v = { mode: await page.locator('#main.transcript').getAttribute('data-view-mode'), gap: await gap(page), closest };
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
  await expect(page.locator(`#main > [data-key="${key}"]`), 'the item you went to is in view').toBeInViewport();
  expect.soft(v.mode, 'it reads there').toBe('reading');
  expect.soft(v.closest, 'no frame after the jump went to the end').toBeGreaterThan(400);
  // The jump drew its item twice, a frame apart (its second placement): once both have let go, it can be skipped again.
  const held = await page.locator(`#main > [data-key="${key}"]`).evaluate((el) => /** @type {HTMLElement} */ (el).style.contentVisibility);
  expect.soft(held, 'the item is let go once painted, not left drawn').toBe('');
});
