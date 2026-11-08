// Jump to latest over skipped items (#712a): the pill scrolls smoothly to the end of the main pane. The items it passes
// draw for the first time on the way down (`content-visibility: auto`, app/workbench.css), and each draw re-applies the
// view (app/js/view-state.mjs). While the jump runs, that mustn’t snap the view to the end, and when it ends short of a
// page that grew as it drew, it goes the rest of the way. A wheel up during it is you reading. Each test has a
// conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox } from './postbox.mjs';
import { traceNear, traceScrolls } from './scroll-trace.mjs';
import { still } from './view-skipped-fixture.mjs';
import { readingAtTop as atTop } from './view-smooth-fixture.mjs';

// Tracing is off: Playwright’s trace snapshots walk all 1,000 items with their skipped styles each action, which
// takes longer than the test.
test.use({ colorScheme: 'light', trace: 'off', reducedMotion: 'no-preference' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-smooth');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

// How far back scrollY may step as the page settles near the end: a line of text at the usual size. Firefox on a Mac
// stepped back 2–8 px, and Chromium on CI too, both with the view ending following at the end. What this guards is the
// view turning back, which was hundreds to thousands of px (a late wheel turn, the jump read as your scroll). Every
// step back is listed in the measured line (`back`) whatever its size.
const SETTLES = 16;

/** @param {any} page @param {string} title */
const readingAtTop = (page, title) => atTop(app, page, title);

/** Records scrollY every frame from now until it has held for 30 frames, or 10 s. */
const record = async (page) => {
  await traceScrolls(page);
  return page.evaluate(() => {
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
};
const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).smoothDone);
/** Each frame where scrollY went back up: where from and to, and the page’s height in the frame before and in it. */
const backSteps = (page) =>
  page.evaluate(() => {
    const { smoothYs: ys, smoothHs: hs } = /** @type {any} */ (window);
    return ys.flatMap((/** @type {number} */ y, /** @type {number} */ i) =>
      i && y < ys[i - 1] ? [{ frame: i, from: ys[i - 1], to: y, heightBefore: hs[i - 1], height: hs[i] }] : [],
    );
  });
/**
 * How many frames scrollY went back up by more than SETTLES and left the view short of the end. A clamp to an end
 * that came up, as items near it drew shorter, steps scrollY back with the view still at the end, so what’s on screen
 * holds (CI on ebe964fd: 56 px, the gap 0 before and after).
 */
const leftEnd = (page) =>
  page.evaluate((settles) => {
    const { smoothYs: ys, smoothHs: hs } = /** @type {any} */ (window);
    return ys.filter((/** @type {number} */ y, /** @type {number} */ i) => i && y < ys[i - 1] - settles && hs[i] - innerHeight - y > 2).length;
  }, SETTLES);
const gap = (page) => page.evaluate(() => document.documentElement.scrollHeight - scrollY - innerHeight);

/**
 * Clicks Jump to latest, and returns a wait for the jump’s end: its scrollend, heard after the transcript’s own, so the
 * view has taken in how it ended. Mac Firefox, events late, held still for two frames between the jump’s last scroll
 * and its scrollend, and a case read the mode before the view did (researcher’s trace on fb5edc6d, 2 of 40).
 */
async function jump(page) {
  await page.locator('.jump').getByRole('button').click();
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.pbJumpEnded = false;
    addEventListener('scrollend', () => (w.pbJumpEnded = true), { once: true });
  });
  return () => expect.poll(() => page.evaluate(() => /** @type {any} */ (window).pbJumpEnded), { message: 'the jump’s scrollend' }).toBe(true);
}

// CI’s runners: once the jump landed at the end, Chromium’s smooth scroll, aimed at a page that shrank under it, stepped
// back from the end by 138–563 px a frame later, with nothing of the page’s writing (a trace with the CPU throttled 3x,
// 14 of 20; on CI, 319 px), and the view read that as you. With the CPU throttled as slow, from the click on.
test('Jump to latest over 1,000 far shorter items on a slow CPU never steps back from the end', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the CPU is throttled through Chromium’s DevTools protocol');
  await page.addInitScript((rule) => {
    addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: rule })));
  }, '.transcript .item { line-height: 0.9 !important; font-size: 8px !important }');
  await readingAtTop(page, 'Smooth jump on a slow CPU');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 3 });
  await record(page);
  await page.locator('.jump').getByRole('button').click();
  await recorded(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await still(page);
  const v = {
    backwards: await leftEnd(page),
    mode: await page.locator('#main.transcript').getAttribute('data-view-mode'),
    gap: await gap(page),
    back: await backSteps(page),
  };
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
  if (v.backwards) test.info().annotations.push({ type: 'trace', description: JSON.stringify(await traceNear(page, v.back)) });
  expect.soft(v.backwards, `scrollY never goes back up by more than ${SETTLES} px, short of the end`).toBe(0);
  expect.soft(v.mode, 'it ends following').toBe('following');
  expect.soft(v.gap, 'it ends at the end').toBeLessThanOrEqual(2);
});

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
      backwards: await leftEnd(page),
      mode: await page.locator('#main.transcript').getAttribute('data-view-mode'),
      gap: await gap(page),
      back: await backSteps(page),
    };
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
    if (v.backwards) test.info().annotations.push({ type: 'trace', description: JSON.stringify(await traceNear(page, v.back)) });
    expect.soft(v.distinct, 'scrollY takes many values on the way down').toBeGreaterThan(5);
    expect.soft(v.backwards, `scrollY never goes back up by more than ${SETTLES} px, short of the end`).toBe(0);
    expect.soft(v.biggest, 'no one frame jumps more than 60% of the way').toBeLessThanOrEqual(0.6 * distance);
    expect.soft(v.mode, 'it ends following').toBe('following');
    expect.soft(v.gap, 'it ends at the end').toBeLessThanOrEqual(2);
  });

test('a wheel up during the jump is you reading: the view stays where you turned it, not dragged to the end', async ({ page, browserName }) => {
  await readingAtTop(page, 'Smooth jump, then a wheel up');
  const ended = await jump(page);
  // Partway down, and still moving. Chromium ends the jump on the wheel turn, and drops the turn’s own scroll.
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -400);
  await ended();
  await still(page);
  const v = { mode: await page.locator('#main.transcript').getAttribute('data-view-mode'), gap: await gap(page) };
  // Firefox didn’t always stop its smooth scroll for the test’s wheel turn: the scroll went on to the end, where reading
  // and following are the same place. There it’s recorded, not judged; whether a real wheel stops it isn’t known.
  const stopped = browserName !== 'firefox' || v.gap > 2;
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ ...v, stopped }) });
  if (!stopped) return;
  expect.soft(v.mode, 'it reads where you turned the wheel').toBe('reading');
  // Chromium ends the jump on the turn, well short of the end. Firefox can carry the view on toward it first (180 px
  // short on a Mac, researcher’s check on 49a5bf91), so there it’s enough that the view reads short of the end.
  const short = browserName === 'firefox' ? 2 : 400;
  expect.soft(v.gap, `it isn’t at the end: more than ${short} px short of it`).toBeGreaterThan(short);
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
    const ended = await jump(page);
    await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
    await act(page);
    await ended();
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

// critic on #959: CI and Mac Firefox failed the wheel case now and then once landed() came in. landed() ended the jump
// at the end even when a wheel turn of yours had come during it, cutting your turn short. A wheel event is heard as
// yours here, the same way whenSmoothEnds hears one, and landed() mustn’t write its jump to the end after it.
test('a wheel turn heard during the jump to the end keeps landed() from ending it there', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the CPU is throttled through Chromium’s DevTools protocol');
  // Far shorter items, so the page shrinks under the jump and it lands at the end, which is when landed() acts.
  await page.addInitScript((rule) => {
    addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: rule })));
  }, '.transcript .item { line-height: 0.9 !important; font-size: 8px !important }');
  await readingAtTop(page, 'Smooth jump, a wheel heard as it lands');
  // Slowed as CI is.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 3 });
  await record(page);
  await page.locator('.jump').getByRole('button').click();
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'the jump to be on its way' }).toBeGreaterThan(2000);
  await page.evaluate(() => dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
  await recorded(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await still(page);
  const writes = await page.evaluate(() =>
    /** @type {any[]} */ (/** @type {any} */ (window).scrollTrace).filter((t) => t.kind.startsWith('write') && t.at?.includes('landed')),
  );
  expect(writes, 'landed() wrote no scroll after your wheel turn').toEqual([]);
});
