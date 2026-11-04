// Skipped items (#712a): the transcript keeps every item mounted, and the browser skips the layout and paint of those
// off screen (`content-visibility: auto`, app/workbench.css), laying each out at an estimated size until it draws. The
// view (app/js/view-state.mjs) keeps your place as skipped items draw. Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { FIRST_DAY_WORD } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright's trace snapshots walk all 1,000 items with their skipped styles each action, which
// takes longer than the test.
test.use({ colorScheme: 'light', trace: 'off' });

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
  test(`V3 in ${where}: reading where no item has drawn yet, what you read stays put while the items around it draw`, async ({ page }) => {
    const inPanel = where !== '#main';
    const room = inPanel ? sideRoom('Skipped: V3 in the panel') : { conv: bigRoom(app, 'Skipped: V3'), side: null };
    await open(page, { ...room, count: 1000 });
    const shown = room.side ?? room.conv;
    // Put the view halfway up, among items that have never drawn and so sit at the estimate, and take the anchor
    // there. Then, frame by frame, the items above and below it draw at their real sizes.
    const v = await page.evaluate(
      async ({ threadId, inPanel }) => {
        const el = /** @type {HTMLElement} */ (document.querySelector(`.transcript[data-thread="${threadId}"]`));
        const box = /** @type {Element} */ (inPanel ? el.parentElement : document.scrollingElement);
        const top = () => (inPanel ? box.getBoundingClientRect().top : 0);
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        box.scrollTop = box.scrollHeight / 2;
        await frame();
        await frame();
        const key = String(el.dataset.viewAnchor);
        const anchor = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${CSS.escape(key)}"]`));
        const at = anchor.getBoundingClientRect().top - top();
        let worst = 0;
        for (let i = 0; i < 20; i++) {
          await frame();
          worst = Math.max(worst, Math.abs(anchor.getBoundingClientRect().top - top() - at));
        }
        return { mode: el.dataset.viewMode, key, now: el.dataset.viewAnchor, worst };
      },
      { threadId: shown.id, inPanel },
    );
    expect(v.mode).toBe('reading');
    expect(v.now, 'the anchor is the same item').toBe(v.key);
    expect(v.worst, 'the item you were reading moved at most 1 px in any frame while its neighbours drew').toBeLessThanOrEqual(1);
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
