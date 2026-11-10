// #1000: a table wider than its block cut off its last column, a clipped “O” over a stray “#”, with nothing to say
// it scrolled sideways. The table’s frame now fades the edge that has more columns past it, and follows the scroll;
// a table that fits shows no fade. The scroll region is a named tab stop, so a keyboard can scroll it too.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focusIs, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let t;

// Eight columns of long unbroken values: wider than the block at 1280 px, and far wider at 375 px.
const COLS = ['Title', 'Author', 'Publisher', 'Edition', 'Language', 'Shelf', 'Catalog', 'Other copies'];
const wide = {
  id: 'works',
  type: 'table',
  version: 1,
  title: 'Works',
  fallback: 'Works',
  columns: COLS.map((label, i) => ({ id: `c${i}`, label })),
  rows: [1, 2, 3].map((n) => ({ id: `r${n}`, cells: Object.fromEntries(COLS.map((_, i) => [`c${i}`, `Value${n}${i}ABCDEFGHIJKLMNO`])) })),
};
const narrow = {
  id: 'pair',
  type: 'table',
  version: 1,
  title: 'Pair',
  fallback: 'Pair',
  columns: [
    { id: 'a', label: 'Name' },
    { id: 'b', label: 'Count', kind: 'number' },
  ],
  rows: [{ id: 'r1', cells: { a: 'One', b: 1 } }],
};

test.beforeAll(async () => {
  app = await startPostbox('table-scroll-cue');
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  t = rt.createThread({ projectId: project.id, title: 'Book shelf', personaIds: [rt.personaByHandle('librarian').id] });
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  tools.show_block({ block: wide });
  tools.show_block({ block: narrow });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const region = (page, title) => page.getByRole('region', { name: `${title}, scrolls` });

/**
 * Which edges of a table’s scroll region show the fade: its frame (`.tbl-scroll`) draws the left one as ::before and
 * the right one as ::after, shown when opaque. No frame, no fade.
 * @param {import('@playwright/test').Locator} scroller
 */
const cue = (scroller) =>
  scroller.evaluate((el) => {
    const frame = el.closest('.tbl-scroll');
    const shown = (pseudo) => {
      if (!frame) return false;
      const s = getComputedStyle(frame, pseudo);
      return s.content !== 'none' && s.backgroundImage !== 'none' && Number(s.opacity) > 0.9 && Number.parseFloat(s.width) >= 12;
    };
    return { left: shown('::before'), right: shown('::after') };
  });

/** Opens the conversation, with the region of the table of that title in view. */
async function open(page, title) {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const scroller = region(page, title);
  await scroller.scrollIntoViewIfNeeded();
  await settled(page);
  return scroller;
}

/** Scrolls a region sideways to where that puts it, given its scrollable width. */
const scrollTo = (scroller, where) => scroller.evaluate((el, w) => el.scrollTo({ left: w * (el.scrollWidth - el.clientWidth) }), where);

async function wideTableFollowsTheScroll(page) {
  const works = await open(page, 'Works');
  const size = await works.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(size.scroll, 'the table is wider than its block').toBeGreaterThan(size.client + 40);
  await test.step('at rest, the right edge fades', async () => {
    await expect.soft.poll(() => cue(works)).toEqual({ left: false, right: true });
  });
  await test.step('part way, both edges fade', async () => {
    await scrollTo(works, 0.5);
    await expect.soft.poll(() => cue(works)).toEqual({ left: true, right: true });
  });
  await test.step('at the end, only the left edge fades', async () => {
    await scrollTo(works, 1);
    await expect.soft.poll(() => cue(works)).toEqual({ left: true, right: false });
  });
  await test.step('back at the start, only the right edge again', async () => {
    await scrollTo(works, 0);
    await expect.soft.poll(() => cue(works)).toEqual({ left: false, right: true });
  });
}

async function narrowTableShowsNone(page) {
  const pair = await open(page, 'Pair');
  const size = await pair.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(size.scroll, 'the table fits its block').toBeLessThanOrEqual(size.client);
  // The wide table’s fade shows, so no fade here is this table fitting, not a missing frame.
  await expect.poll(() => cue(region(page, 'Works'))).toEqual({ left: false, right: true });
  expect(await cue(pair)).toEqual({ left: false, right: false });
}

async function keyboardScrollsTheRegion(page) {
  const works = await open(page, 'Works');
  // Tab from the control before it, the table’s Expand.
  await page.getByRole('button', { name: 'Expand table' }).first().focus();
  await page.keyboard.press('Tab');
  await focusIs(page, 'region: Works, scrolls');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => works.evaluate((el) => el.scrollLeft), { message: 'ArrowRight scrolled the table sideways' }).toBeGreaterThan(0);
  await expect.soft.poll(() => cue(works)).toEqual({ left: true, right: true });
}

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use(
      width === 375
        ? {
            viewport: { width: 375, height: 812 },
            hasTouch: true,
            deviceScaleFactor: 2,
            // Firefox has no mobile emulation; its run checks the narrow window alone.
            isMobile: async ({ browserName }, use) => use(browserName !== 'firefox'),
          }
        : {},
    );

    test(`#1000 a wide table shows which side scrolls, and follows the scroll, at ${width} px`, ({ page }) => wideTableFollowsTheScroll(page));
    test(`#1000 a table that fits shows no fade, at ${width} px`, ({ page }) => narrowTableShowsNone(page));
    test(`#1000 the wide table’s scroll region is a named tab stop the keyboard scrolls, at ${width} px`, ({ page }) => keyboardScrollsTheRegion(page));
  });
}
