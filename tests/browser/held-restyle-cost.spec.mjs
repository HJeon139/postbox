// While you follow, the transcript keeps the room below its newest message that a working row or a card gave up
// (view-state.mjs follow() and release(), #712a). It was a custom property on the transcript, `--held`, read by its
// bottom padding. Every element in the transcript inherits a custom property, so setting it or clearing it restyled
// them all: in the person’s Firefox profile, 614,000 elements and 1.2–1.5 s a time, once per new message (#1150).
// Chromium’s trace gives each style recalc the number of elements it styled. Here the hold is set as follow() sets it
// and cleared as release() clears it, and each restyles only the transcript. The page reads its hold off the
// transcript’s style, so the case does the same, whatever property it lives in. The counts are taken around those two
// writes alone: with events late, the frames around a new message also restyle for other reasons, 21,000 elements once
// on the fix, which would hide what the hold costs. That a new message does clear the hold is checked on its own.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced, wholeRoom } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: Playwright’s trace snapshot walks the page each action, which restyles it too.
test.use({ trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('held-restyle-cost');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
// The cost is counted over a whole room, every item mounted, as on main before the window (#866).
wholeRoom(test);

/** The elements Chromium restyled while `run` ran, and until the page held still after. */
async function restyledOver(page, run) {
  const browser = /** @type {import('@playwright/test').Browser} */ (page.context().browser());
  await browser.startTracing(page, { categories: ['devtools.timeline', 'blink'] });
  await run();
  await still(page);
  const trace = JSON.parse((await browser.stopTracing()).toString());
  let elements = 0;
  for (const e of trace.traceEvents ?? trace) {
    if (e.name === 'UpdateLayoutTree' && e.ph !== 'E') elements += e.args?.elementCount ?? 0;
  }
  return elements;
}

// In the page: hold 40 px below the newest message, as follow() does, and whether a hold is set. On main the hold
// was `--held`; from #1150 it’s the transcript’s own bottom margin.
function holdRoom(on) {
  const t = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
  const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
  // `--held` is only for the run that fails first, on the code before #1150; once that’s gone, it’s the margin.
  const prop = rules.some((rule) => rule.cssText.includes('var(--held')) ? '--held' : 'margin-bottom';
  if (on) t.style.setProperty(prop, '40px');
  else t.style.removeProperty(prop);
}
const held = () => {
  const t = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
  return !!(t.style.getPropertyValue('--held') || t.style.marginBottom);
};

test('#1150 following, setting and clearing the room held below the newest message restyles the transcript, not the room', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the style recalc counts come from Chromium’s trace');
  const conv = bigRoom(app, 'Held, then a message');
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${conv.id}"] > .item`)).toHaveCount(1000, { timeout: 15_000 });
  await still(page);
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-view-mode', 'following');
  const total = await page.evaluate(() => document.querySelectorAll('#main.transcript *').length);
  // The held room, as follow() leaves it once something below the newest message shrank.
  const setting = await restyledOver(page, () => page.evaluate(holdRoom, true));
  const clearing = await restyledOver(page, () => page.evaluate(holdRoom, false));
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ total, setting, clearing }) });
  // On main each restyled every element Chromium wasn’t skipping off screen, about 1,500 of the room’s 14,716 here, and
  // Firefox all of them, 614,000 in the person’s profile.
  expect.soft(setting, `elements restyled setting the held room, of ${total}`).toBeLessThan(200);
  expect.soft(clearing, `elements restyled clearing it, of ${total}`).toBeLessThan(200);
  // And a new message is what clears it, as release() does.
  await page.evaluate(holdRoom, true);
  const it = arrange.post(app.rt, conv.id, { kind: 'user', text: 'A new message, which lets the held room go.' });
  // Wait as synced() does, by polling the page's event number. Expect's in-page wait for the item, on a room of about
  // 15,000 elements on a loaded CI runner, held the page's own handling of the event back 8 to 15 s (#1221): it heard
  // the event in 0.3 s when the wait polled from outside, the same page and room otherwise.
  await synced(page, app, 15_000);
  await expect(page.locator(`[data-key="${it.id}"]`), 'the message to reach the page').toBeAttached({ timeout: 1000 });
  await expect.poll(() => page.evaluate(held), { message: 'the held room to go' }).toBe(false);
});
