// The UAT’s skipped-items probe and its check (#712a, tools/uat/skip-probe.mjs, tools/uat/checks-view.mjs), in
// Chromium: on a room of 1,200 items, nearly all are skipped with the rule on, and none once the transcript loses its
// cv-skip class, so rows-skipped is silent on the first and fires on the second. RECORD_SKIP_SAMPLES=1 writes the two
// samples to tests/fixtures/uat/skip-probe-samples.json, which tests/uat-checks-view.test.mjs reads.

import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { VIEW_CHECKS } from '../../tools/uat/checks-view.mjs';
import { sampleSkipped } from '../../tools/uat/skip-probe.mjs';
import { failOnPageErrors, startPostbox, synced, wholeRoom } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: its snapshots walk every item with its skipped styles each action (tests/browser/view-skipped.spec.mjs).
test.use({ trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('skip-probe');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
// Every item mounted, the window off: this spec is of the whole-room path (postbox.mjs, wholeRoom).
wholeRoom(test);

const COUNT = 1200;
const rowsSkipped = (samples) => VIEW_CHECKS.find((c) => c.id === 'rows-skipped')?.run({ probes: { skipped: samples } });

test('the probe counts the items skipped, and rows-skipped fires only once the rule is off', async ({ page }) => {
  const conv = bigRoom(app, 'Skipped, sampled', COUNT);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator('#main.transcript > .item')).toHaveCount(COUNT, { timeout: 15_000 });
  await still(page);
  const ev = (e) => page.evaluate(e);
  const on = { step: 1, at: 1, ...(await sampleSkipped(ev)) };
  expect.soft([on.items, on.supported, on.gated, on.settled]).toEqual([COUNT, true, true, true]);
  expect.soft(on.skipped, 'nearly every item is skipped').toBeGreaterThan(COUNT * 0.9);
  expect.soft(rowsSkipped([on]), 'silent with the rule on').toEqual([]);
  await page.evaluate(() => document.querySelector('#main.transcript')?.classList.remove('cv-skip'));
  const off = { step: 2, at: 2, ...(await sampleSkipped(ev)) };
  expect.soft([off.items, off.skipped, off.gated, off.settled]).toEqual([COUNT, 0, false, true]);
  expect.soft(rowsSkipped([off]), 'fires with the rule off').toHaveLength(1);
  if (process.env.RECORD_SKIP_SAMPLES) {
    const recorded = `Chromium (Playwright), ${new Date().toUTCString().slice(5, 16)}, from tests/browser/skip-probe.spec.mjs's room of ${COUNT} items at 1,280 × 800: 'on' sampled once the page held still, 'off' after removing the transcript's cv-skip class in the page.`;
    const out = new URL('../fixtures/uat/skip-probe-samples.json', import.meta.url);
    writeFileSync(out, `${JSON.stringify({ recorded, on: [on], off: [off] }, null, 2)}\n`);
  }
});
