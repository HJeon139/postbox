// Fitting choices costs one layout, not one per choice (#866). The options observer measured each choice between two
// writes, and each read forced a layout of the whole page, so opening a room with many choices grew with
// choices × items. Chromium counts the page’s layouts (the DevTools protocol’s Performance.getMetrics, LayoutCount):
// opening a room with many choices takes about as many as opening one with a few.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

// Tracing is off: Playwright’s trace snapshot walks the page each action, and an item the transcript skips (#712a) is
// laid out on its own when the walk reaches it, so with 60 choices the snapshots took 351 of the 374 layouts counted.
test.use({ trace: 'off' });

const OPTIONS = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];
const FEW = 3;
const MANY = 60;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drafter;
test.beforeAll(async () => {
  app = await startPostbox('choice-layout-cost');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_session, message, ctx) {
      if (message.kind !== 'user') return;
      const n = Number(message.text);
      for (let i = 0; i < n; i++) ctx.tools.show_block({ block: { id: `c${i}`, type: 'choice', version: 1, fallback: `c${i}`, options: OPTIONS } });
    },
  });
  drafter = app.rt.createPersona({ handle: 'drafter' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** A conversation with `n` choice blocks waiting. @param {number} n */
async function roomWith(n) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: `${n} choices`, personaIds: [drafter.id] });
  rt.sendMessage(thread.id, { text: String(n) });
  await expect.poll(() => rt.turns.size === 0 && rt.store.items(thread.id).filter((i) => i.kind === 'block').length === n).toBe(true);
  return thread.id;
}

/** How many layouts the page did opening the conversation, until it held still. */
async function layoutsOpening(page, cdp, threadId) {
  const before = await layoutCount(cdp);
  await page.goto(`${app.origin}/#/t/${threadId}`);
  await synced(page, app);
  await expect(page.locator('.chips').first()).toBeVisible();
  await settled(page);
  return (await layoutCount(cdp)) - before;
}

async function layoutCount(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'LayoutCount').value;
}

test('#866 opening a room with 60 choices takes about as many layouts as one with 3', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const few = await roomWith(FEW);
  const many = await roomWith(MANY);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(`${app.origin}/#/t/${few}`);
  await settled(page);
  const withFew = await layoutsOpening(page, cdp, few);
  const withMany = await layoutsOpening(page, cdp, many);
  test.info().annotations.push({ type: 'measured', description: `layouts opening ${FEW} choices: ${withFew}; ${MANY} choices: ${withMany}` });
  // One per choice would be at least MANY − FEW more; batched, it’s the same handful whatever the count. The bar is
  // half that, since a lagged stream spreads the opening over more frames (11 more with POSTBOX_STREAM_LAG=300 once).
  expect(withMany - withFew, `layouts: ${withFew} with ${FEW} choices, ${withMany} with ${MANY}`).toBeLessThan((MANY - FEW) / 2);
});
