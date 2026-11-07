// A jump in a room of skipped items (#712a): with `content-visibility: auto`, the items off screen sit at an estimate
// until they draw, so a jump lands where the estimates put its target, and the items around it then draw at their
// real sizes. jumpTo (app/js/view-jump.mjs) puts the target where its block says and keeps its item as the anchor
// while they do (view-state.mjs, pin()), until you scroll. On a 10,000-item room at 1280×800, opened at its end: jumps
// to the first item, the middle, the last and an item far above with block 'start', and a wheel turn after a jump.
// A plain scrollIntoView left the first item 166 px above the view. Items with a diagram: view-jump-diagram.spec.mjs.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox } from './postbox.mjs';
import { COUNT, jump, landed, openRoom, placed, where } from './view-jump-fixture.mjs';
import { bigRoom } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright's trace snapshots walk every node of the page each action, and on a room of 1,000 items
// or more under content-visibility that takes longer than the test (view-skipped.spec.mjs).
test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
test.beforeAll(async () => {
  app = await startPostbox('view-jump');
  room = bigRoom(app, 'Jumps', COUNT);
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
test.beforeEach(() => test.setTimeout(120_000));

for (const [name, at, block] of /** @type {const} */ ([
  ['the first item', 0, 'center'],
  ['the middle item (5,000)', 5000, 'center'],
  ['an item 8,000 above the view, to its start', 2000, 'start'],
])) {
  test(`a jump to ${name} lands where its block puts it, and it's the anchor once the items around it draw`, async ({ page }) => {
    await openRoom(app, page, room);
    const key = await jump(page, at, block);
    await landed(page);
    const v = await where(page, key, block);
    test.info().annotations.push({ type: 'measured', description: `${placed(v)}: ${JSON.stringify(v)}` });
    expect.soft(v.mode, 'reading').toBe('reading');
    expect.soft(v.anchor, 'the target is the anchor').toBe(key);
  });
}

// Items shorter than their estimate, as the Mac’s fonts draw them, as well as at their usual size: centring the last
// item then leaves room below it, so it’s the jump’s own rule, not the page’s geometry, that lands it at the end.
for (const [sizes, css] of [
  ['its usual size', ''],
  ['shorter than its estimate', '.transcript .item { line-height: 1.05 !important; font-size: 12px !important }'],
]) {
  test(`a jump to the last item lands at the end, following, with items at ${sizes}`, async ({ page }) => {
    await openRoom(app, page, room);
    if (css) await page.addStyleTag({ content: css });
    // Up from the end first, so the jump has somewhere to go.
    await jump(page, 5000, 'center');
    await landed(page);
    const key = await jump(page, -1, 'center');
    await landed(page);
    const v = await where(page, key, 'center');
    // The newest message goes to the end, whatever its block, so it isn’t placed by its block: it’s in view, at the end.
    test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
    expect.soft(v.top + v.height, 'its end is below the top bar').toBeGreaterThan(0);
    expect.soft(v.top, 'and its top above the window’s bottom').toBeLessThan(800);
    expect.soft(v.atEnd, 'at the end').toBe(true);
    expect.soft(v.mode, 'following').toBe('following');
  });
}

test('after a jump, your own wheel turn takes the anchor at the middle again, not the jump’s target', async ({ page }) => {
  await openRoom(app, page, room);
  const key = await jump(page, 2000, 'start');
  await landed(page);
  expect(await where(page, key, 'start'), 'the jump pinned its target').toMatchObject({ anchor: key });
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 300);
  await landed(page);
  // The anchor is taken as findAnchor takes it (app/js/view-anchor.mjs): the first item whose bottom is past the
  // middle, which starts just below it when the middle falls in the gap between two items.
  const v = await page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
    const n = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${CSS.escape(String(el.dataset.viewAnchor))}"]`));
    const before = /** @type {HTMLElement} */ (n.previousElementSibling);
    return {
      mode: el.dataset.viewMode,
      anchor: el.dataset.viewAnchor,
      offset: el.dataset.viewOffset,
      before: before.getBoundingClientRect().bottom,
      bottom: n.getBoundingClientRect().bottom,
      mid: innerHeight / 2,
    };
  });
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
  expect.soft(v.mode, 'reading').toBe('reading');
  expect.soft(v.anchor, 'a new anchor').not.toBe(key);
  expect.soft(v.before <= v.mid && v.bottom > v.mid, `the anchor is the first item past the middle: ${JSON.stringify(v)}`).toBe(true);
});
