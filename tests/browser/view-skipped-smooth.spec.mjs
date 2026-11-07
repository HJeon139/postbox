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
  // held for 30 frames before the jump, so no wheel scroll still landing is taken for one during it.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -2000);
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-view-mode', 'reading');
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.evaluate(heldAtTop), { message: 'the view to hold at the top for 30 frames', timeout: 15_000 }).toBe(true);
  await still(page);
  app.rt.addItem(conv.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: 'A reply since.', status: 'done' });
  // With the server's events late and ten of these rooms at once, the reply took over 5 s to reach the page.
  await expect(page.locator('.jump')).toBeVisible({ timeout: 15_000 });
}

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
      backwards: steps.filter((d) => d < 0).length,
      mode: await page.locator('#main.transcript').getAttribute('data-view-mode'),
      gap: await gap(page),
      back: await backSteps(page),
    };
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
    expect.soft(v.distinct, 'scrollY takes many values on the way down').toBeGreaterThan(5);
    expect.soft(v.backwards, 'scrollY never goes back up').toBe(0);
    expect.soft(v.biggest, 'no one frame jumps more than 60% of the way').toBeLessThanOrEqual(0.6 * distance);
    expect.soft(v.mode, 'it ends following').toBe('following');
    expect.soft(v.gap, 'it ends at the end').toBeLessThanOrEqual(2);
  });

test('a wheel up during the jump is you reading: the view stays where you turned it, not dragged to the end', async ({ page }) => {
  await readingAtTop(page, 'Smooth jump, then a wheel up');
  await page.locator('.jump').getByRole('button').click();
  // Partway down, and still moving. Chromium ends the jump on the wheel turn, and drops the turn's own scroll.
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -400);
  await still(page);
  const v = { mode: await page.locator('#main.transcript').getAttribute('data-view-mode'), gap: await gap(page) };
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
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
