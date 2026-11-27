// The layout check of Postbox’s own screens (#681, tools/text-layout.mjs): on a page built to draw text over text and
// over a button, cut text off and break words a few letters a line, both the browser specs’ helper
// (tests/browser/text-layout.mjs) and the UAT runner’s check of each whole-window screenshot (tools/uat/layout-probe.mjs,
// tools/uat/checks-view.mjs) fail, at 375 and 1280 px; on a clean page, and on Postbox’s own first screen, both pass.

import { expect, test } from '@playwright/test';
import { runChecks } from '../../tools/uat/checks.mjs';
import { failsRun } from '../../tools/uat/checks-postbox.mjs';
import { recordLayout, sampleLayout } from '../../tools/uat/layout-probe.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { expectTidyText, textLayout } from './text-layout.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('text-layout');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// Sizes are in px and ch of a monospace face, so each page lays out the same at both widths.
const STYLE = `<style>
  body { margin: 0; padding: 16px; font: 16px/1.4 sans-serif; background: #fff; color: #111; }
  .mono { font-family: monospace; }
  section { margin: 0 0 24px; }
  button { font: inherit; }
</style>`;

// One of each problem: text over text, text over a button, text cut off by its box, and a word broken three letters
// a line.
const BAD = `${STYLE}
<section style="position: relative; height: 40px">
  <span>Overlapping words here</span>
  <span style="position: absolute; left: 0; top: 0">Drawn over the first</span>
</section>
<section style="position: relative; height: 40px">
  <span>A sentence a button sits on</span>
  <button style="position: absolute; left: 40px; top: 0">Send now</button>
</section>
<section style="width: 120px; overflow: hidden; white-space: nowrap">This label is far too long for its box</section>
<section class="mono" style="width: 3ch; overflow-wrap: anywhere">Configuration</section>`;

// The same kinds of text, laid out well: cut short with an ellipsis, a word broken four letters a line with its last
// part shorter, a word broken at soft hyphens, a word set to break anywhere that fills the line before it breaks, a
// button beside its text, a checkbox in its label, a button under a dialog that text in the dialog crosses, and a
// hidden button under text.
const CLEAN = `${STYLE}
<section style="width: 120px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis">This label is far too long for its box</section>
<section class="mono" style="width: 4ch; overflow-wrap: anywhere">Configuration</section>
<section class="mono" style="width: 3ch">ab&shy;cd&shy;ef&shy;gh</section>
<section class="mono" style="width: 8ch; word-break: break-all">Open xyzabcdefghijklmnop</section>
<section><span>A sentence and its button</span> <button>Send now</button></section>
<section><label><input type="checkbox"> Keep it updated</label></section>
<section style="position: relative; height: 80px">
  <button style="position: absolute; left: 0; top: 8px">Hidden under the dialog</button>
  <div role="dialog" style="position: absolute; inset: 0; background: #eee; padding: 8px">Dialog text over the page</div>
</section>
<section style="position: relative">
  <span>Text over a hidden button</span>
  <button style="position: absolute; left: 0; top: 0; visibility: hidden">Hidden</button>
</section>`;

const CODES = ['mid-word-break', 'text-cut-off', 'text-on-control', 'text-overlap'];
/** @param {import('@playwright/test').Page} page  @param {string} html  @param {number} width */
async function open(page, html, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(html);
}

for (const width of [375, 1280]) {
  test(`#681 at ${width} px a page that draws text over text and a button, cuts it off and breaks words fails the check`, async ({ page }) => {
    await open(page, BAD, width);
    const found = await textLayout(page);
    expect.soft([...new Set(found.map((p) => p.code))].sort(), 'one of each problem the page was built with').toEqual(CODES);
    for (const p of found) {
      // Each names its element by a selector path, and quotes no more than 40 characters of its text and an ellipsis.
      expect.soft(p.message, 'names where it is').toMatch(/\((?:[\w.#:()-]+(?: > )?)+\)/);
      for (const [, quote] of p.message.matchAll(/“([^”]*)”/g)) expect.soft(quote.length, `“${quote}” is short`).toBeLessThanOrEqual(41);
    }
    await expect(expectTidyText(page, 'the bad page'), 'the specs’ helper fails it').rejects.toThrow(/text-overlap|text-on-control|cut off|mid-word/);
  });

  test(`#681 at ${width} px the UAT check of a whole-window screenshot fails the run on the bad page, and passes a clean one`, async ({ page }) => {
    const ev = (/** @type {string} */ expr) => page.evaluate(expr);
    const probes = {};
    const record = recordLayout(probes, () => 1);
    await open(page, BAD, width);
    record(await sampleLayout(ev));
    const bad = runChecks({ probes }, { only: ['text-layout'] });
    expect.soft(bad.length, 'a finding for each problem').toBeGreaterThanOrEqual(CODES.length);
    expect.soft(failsRun(bad), 'the findings fail the run').toBe(true);
    const clean = { layout: [] };
    await open(page, CLEAN, width);
    recordLayout(clean, () => 2)(await sampleLayout(ev));
    expect.soft(runChecks({ probes: clean }, { only: ['text-layout'] }), 'nothing on the clean page').toEqual([]);
  });

  test(`#681 at ${width} px a clean page passes the check`, async ({ page }) => {
    await open(page, CLEAN, width);
    await expectTidyText(page, 'the clean page');
  });

  test(`#681 at ${width} px Postbox’s first screen passes the check`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${app.origin}/`);
    await synced(page, app);
    await expectTidyText(page, 'Postbox’s first screen');
  });
}
