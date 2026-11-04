// Skipped items (#712a): the transcript keeps every item mounted, and the browser skips the layout and paint of those
// off screen (`content-visibility: auto`, app/workbench.css), laying each out at an estimated size until it draws. The
// view (app/js/view-state.mjs) keeps your place as skipped items draw. Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { FIRST_DAY_WORD } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Opens a conversation, or a side thread in the panel beside it, and waits for its items to mount and hold still. */
async function open(page, { conv, side = null, count }, width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}${side ? `/side/${side.id}` : ''}`);
  await synced(page, app);
  const shown = side ?? conv;
  await expect(page.locator(`.transcript[data-thread="${shown.id}"] > .item`)).toHaveCount(count, { timeout: 15_000 });
  await still(page);
}

for (const [width, estimate] of [
  [1280, '71px'],
  [375, '91px'],
]) {
  test(`at ${width} px, the browser skips the items off screen, each at an estimate of ${estimate} until it draws`, async ({ page }) => {
    const conv = bigRoom(app, `Skipped at ${width}`);
    await open(page, { conv, count: 1000 }, width);
    const v = await page.evaluate(() => {
      const el = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
      const first = /** @type {HTMLElement} */ (el.querySelector(':scope > .item'));
      const style = getComputedStyle(first);
      return {
        gated: el.classList.contains('cv-skip'),
        visibility: style.contentVisibility,
        size: style.containIntrinsicHeight,
        firstSkipped: !first.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }),
      };
    });
    expect(v).toEqual({ gated: true, visibility: 'auto', size: `auto ${estimate}`, firstSkipped: true });
  });
}

/** A side thread of a 1,000-item room, beside a short conversation. */
function sideRoom(title) {
  const { rt, store } = app;
  const project = /** @type {any} */ (Object.values(store.state.projects)[0]);
  const conv = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id] });
  rt.addItem(conv.id, { kind: 'user', text: 'A short conversation, with its long topic beside it.' });
  const side = rt.createThread({
    projectId: conv.projectId,
    title: 'A topic',
    kind: 'side',
    parentId: conv.id,
    personaIds: [rt.personaByHandle('researcher').id],
  });
  bigRoom(app, title, 1000, side);
  return { conv, side };
}

for (const where of ['#main', 'the side panel']) {
  test(`V3 in ${where}: an item above the anchor grows as one below shrinks by as much, in one frame, and what you read stays put`, async ({ page }) => {
    const inPanel = where !== '#main';
    const room = inPanel ? sideRoom('Skipped: V3 in the panel') : { conv: bigRoom(app, 'Skipped: V3'), side: null };
    await open(page, { ...room, count: 1000 });
    const scroller = page.locator(inPanel ? '.sidepanel .sp-body' : '#main');
    const at = /** @type {{ x: number, y: number, width: number }} */ (await scroller.boundingBox());
    await page.mouse.move(at.x + at.width / 2, inPanel ? at.y + 200 : 400);
    await page.mouse.wheel(0, -3000);
    await still(page);
    const shown = room.side ?? room.conv;
    const v = await page.evaluate(
      async ({ threadId, inPanel }) => {
        const el = /** @type {HTMLElement} */ (document.querySelector(`.transcript[data-thread="${threadId}"]`));
        const top = () => (inPanel ? /** @type {Element} */ (el.parentElement).getBoundingClientRect().top : 0);
        const anchor = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${CSS.escape(String(el.dataset.viewAnchor))}"]`));
        const offset = Number(el.dataset.viewOffset);
        const before = anchor.getBoundingClientRect().top - top();
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const GROWTH = 120;
        // In one frame: the item above the anchor that much taller, the one below that much shorter, so the
        // transcript's height doesn't change. Read in the next frame's callback, that is what this frame painted.
        await frame();
        /** @type {HTMLElement} */ (anchor.previousElementSibling).style.paddingTop = `${GROWTH}px`;
        /** @type {HTMLElement} */ (anchor.nextElementSibling).style.marginBottom = `-${GROWTH}px`;
        await frame();
        return { mode: el.dataset.viewMode, offset, before, painted: anchor.getBoundingClientRect().top - top() };
      },
      { threadId: shown.id, inPanel },
    );
    expect(v.mode).toBe('reading');
    expect(Math.abs(v.before - v.offset), 'the anchor started where the view says').toBeLessThanOrEqual(1);
    expect(Math.abs(v.painted - v.offset), `the item you were reading didn’t move (${v.before} to ${v.painted})`).toBeLessThanOrEqual(1);
  });
}

test('find-in-page finds a word only a skipped item has, and draws that item', async ({ page }) => {
  const conv = bigRoom(app, 'Skipped: find');
  await open(page, { conv, count: 1000 });
  const v = await page.evaluate(async (word) => {
    const drawn = (/** @type {Element | null} */ n) => !!n?.firstElementChild?.checkVisibility({ contentVisibilityAuto: true });
    const holders = [...document.querySelectorAll('#main.transcript > .item')].filter((n) => n.textContent?.includes(word));
    const skippedBefore = holders.every((n) => !drawn(n));
    let matched = 0;
    document.addEventListener('beforematch', () => matched++, { capture: true });
    const found = /** @type {any} */ (window).find(word, false, false, true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const node = getSelection()?.anchorNode;
    const at = (node instanceof Element ? node : node?.parentElement)?.closest('.transcript > .item') ?? null;
    const r = at?.getBoundingClientRect();
    return { holders: holders.length, skippedBefore, found, matched, drawn: drawn(at), inView: !!r && r.bottom > 0 && r.top < innerHeight };
  }, FIRST_DAY_WORD);
  test.info().annotations.push({ type: 'measured', description: JSON.stringify(v) });
  expect.soft(v.holders, 'the word is in the room').toBeGreaterThan(0);
  expect.soft(v.skippedBefore, 'every item holding it was skipped before the search').toBe(true);
  expect.soft(v.found, 'window.find found it').toBe(true);
  expect.soft(v.drawn, 'the item holding it is drawn').toBe(true);
  expect.soft(v.inView, 'the item holding it is in view').toBe(true);
});
