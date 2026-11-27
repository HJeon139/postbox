// The layout check of Postbox’s own screens (#681, tools/text-layout.mjs): on a page built to draw text over text and
// over a button, cut text off and break words a few letters a line, both the browser specs’ helper
// (tests/browser/text-layout.mjs) and the UAT runner’s check of each whole-window screenshot (tools/uat/layout-probe.mjs,
// tools/uat/checks-view.mjs) fail, at 375 and 1280 px; on a clean page, and on Postbox’s own screens, both pass: its
// first screen, a topic thread’s first message faded out above Show all, and Jump to latest over the transcript. A
// running step’s long output, which its box cuts off at the end, is reported.

import { expect, test } from '@playwright/test';
import { TEXT_LAYOUT } from '../../tools/text-layout.mjs';
import { runChecks } from '../../tools/uat/checks.mjs';
import { failsRun } from '../../tools/uat/checks-postbox.mjs';
import { recordLayout, sampleLayout } from '../../tools/uat/layout-probe.mjs';
import * as arrange from '../arrange.mjs';
import { scriptedRoom } from './live-scripts.mjs';
import { settled, synced } from './postbox.mjs';
import { expectTidyText, textLayout } from './text-layout.mjs';

// A Postbox with agents on a scripted backend, so a step can be held while its turn runs.
const scripted = scriptedRoom(test, 'text-layout');

// Sizes are in px and ch of a monospace face, so each page lays out the same at both widths.
const STYLE = `<style>
  body { margin: 0; padding: 16px; font: 16px/1.4 sans-serif; background: #fff; color: #111; }
  .mono { font-family: monospace; }
  section { margin: 0 0 24px; }
  button { font: inherit; }
</style>`;

// One of each problem: text over text, an opaque button misplaced over text, text cut off by its box (twice: the
// second inside a faded section whose fade isn’t what cuts it), and a word broken three letters a line.
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
<section style="mask-image: linear-gradient(#000, #000); -webkit-mask-image: linear-gradient(#000, #000)">
  <div style="width: 120px; overflow: hidden; white-space: nowrap">A faded section, its label still cut</div>
</section>
<section class="mono" style="width: 3ch; overflow-wrap: anywhere">Configuration</section>`;

// The same kinds of text, laid out well: cut short with an ellipsis, a word broken four letters a line with its last
// part shorter, a word broken at soft hyphens, a word set to break anywhere that fills the line before it breaks, a
// button beside its text, a checkbox in its label, a button under a dialog that text in the dialog crosses, a hidden
// button under text, an opaque button floating with the window over a paragraph and over part of another button, as
// Jump to latest does over the transcript, a word set to hyphenate and break anywhere, and text hidden for screen
// readers in a 1 px box, which breaks a letter a line.
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
</section>
<section>
  <div style="position: sticky; top: 0; height: 0"><button style="position: absolute; left: 40px; background: Canvas">Jump</button></div>
  <p style="margin: 0">A paragraph with an opaque button floating over its words</p>
</section>
<section>
  <div style="position: sticky; top: 0; height: 0"><button style="position: absolute; left: 30px; background: Canvas">Jump to latest</button></div>
  <button>Good: react</button>
</section>
<section lang="en" class="mono" style="width: 3ch; hyphens: auto; overflow-wrap: anywhere">Configuration</section>
<section class="mono" style="overflow-wrap: anywhere">Read aloud:
  <span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">Configuration</span>
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
    expect.soft(found.filter((p) => p.code === 'text-cut-off').length, 'both labels cut off, the faded section’s too').toBe(2);
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
    await page.goto(`${scripted.app.origin}/`);
    await synced(page, scripted.app);
    await expectTidyText(page, 'Postbox’s first screen');
  });

  // The step keeps the end of what the call returned, but its box clamps it from the top, so the last lines are the
  // ones hidden: a defect the check finds on a real screen, kept here as one until the clamp keeps the end in view.
  test(`#681 at ${width} px a running step’s long output, cut off at its end, is reported`, async ({ page }) => {
    const who = `runner${width}`;
    const t = scripted.room(`Clamped output at ${width}`, [who]);
    scripted.scripts.set(who, async ({ emit }) => {
      emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'npm test' }, final: true });
      emit({ kind: 'tool_result', id: 'b1', text: OUTPUT });
      await scripted.hold(who, 1);
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await synced(page, scripted.app);
    scripted.app.rt.sendMessage(t.id, { text: 'Run the tests.' });
    await expect.poll(() => scripted.at(who)).toBe(1);
    const output = page.locator('.live-steps .step-output');
    await expect(output).toContainText('test 30 passed');
    expect(await output.evaluate((el) => el.scrollHeight > el.clientHeight + 10), 'the output is clamped').toBe(true);
    const found = await textLayout(page);
    expect(
      found.map((p) => p.code),
      'the step’s cut-off output',
    ).toEqual(['text-cut-off']);
    expect(found[0].message).toContain('span.step-output');
    scripted.go(who);
    await expect.poll(() => arrange.liveTurns(scripted.app.rt)).toBe(0);
  });

  test(`#681 at ${width} px a topic thread’s long first message, clamped with Show all, passes the check`, async ({ page }) => {
    const { rt } = scripted.app;
    const t = scripted.room(`Clamped root at ${width}`, [`reader${width}`]);
    const root = arrange.post(rt, t.id, { kind: 'user', text: ROOT });
    const side = rt.startTopic(t.id, root.id).threadId;
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${scripted.app.origin}/#/t/${t.id}/side/${side}`);
    await synced(page, scripted.app);
    await expect(page.locator('.thread-root .md.clamped')).toContainText('The first paragraph');
    await expect(page.locator('.thread-root').getByRole('button', { name: 'Show all' })).toBeVisible();
    const md = page.locator('.thread-root .md.clamped');
    expect(await md.evaluate((el) => el.scrollHeight > el.clientHeight + 10), 'the first message is clamped').toBe(true);
    await expectTidyText(page, 'a topic thread’s clamped first message');
  });

  test(`#681 at ${width} px Jump to latest over the transcript’s text passes the check`, async ({ page }) => {
    const { rt } = scripted.app;
    const t = scripted.room(`Jump at ${width}`, [`talker${width}`]);
    for (let i = 1; i <= 10; i++) arrange.post(rt, t.id, { kind: 'user', text: LONG(i) });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
    await synced(page, scripted.app);
    await settled(page);
    await page.mouse.move(width / 2, 300);
    await page.mouse.wheel(0, -600);
    await settled(page);
    for (let i = 1; i <= 3; i++) arrange.post(rt, t.id, { kind: 'user', text: `Arrived while you read ${i}` });
    const pill = page.getByRole('button', { name: /^Jump to latest/ });
    await expect(pill).toBeVisible();
    // The pill floats over the transcript, opaque: scrolled until a line of its text is under it.
    expect(await page.evaluate(lineUnderPill), 'a line of text under the pill').toBe(true);
    await settled(page);
    expect(await page.evaluate(lineUnderPill), 'still a line of text under the pill, once the page settles').toBe(true);
    await expect(pill).toBeVisible();
    await expectTidyText(page, 'Jump to latest over the transcript');
  });
}

// The page isn’t a hidden frame: while the check measures, the page’s own animation frames run, so an id one of its
// modules asked for is one it can cancel.
test('#681 the check leaves the page’s animation frames its own while it measures', async ({ page }) => {
  await page.goto(`${scripted.app.origin}/`);
  await synced(page, scripted.app);
  const own = await page.evaluate(`(async () => {
    const raf = window.requestAnimationFrame;
    const measuring = ${TEXT_LAYOUT};
    const same = window.requestAnimationFrame === raf;
    await measuring;
    return same && window.requestAnimationFrame === raf;
  })()`);
  expect(own, 'requestAnimationFrame is the page’s own while the check runs, and after').toBe(true);
});

const OUTPUT = Array.from({ length: 30 }, (_, i) => `test ${i + 1} passed in 0.${i} s`).join('\n');
const ROOT = [
  'The first paragraph says what the thread is about, at some length, so that the message runs past the few lines a topic thread shows of it.',
  'The second paragraph goes on with the details of the plan, which the thread’s replies are about, and adds a few more words.',
  'The third paragraph adds what was tried before, and why it didn’t work, so the thread doesn’t try it again.',
  'The fourth paragraph lists who is working on which part, and what each of them needs from the others.',
  'The fifth paragraph is the end of it, which the panel shows only once you choose Show all.',
].join('\n\n');
const LONG = (n) => `Message ${n}. The loop alternates a thought, an action and an observation, so the plan stays grounded in what the agent saw.`;

/**
 * Whether a line of the transcript’s text is under Jump to latest, scrolled down a few pixels at a time until one is,
 * as far as a message and its actions are tall.
 */
function lineUnderPill() {
  const range = document.createRange();
  const crosses = (/** @type {DOMRect} */ pill) => {
    const walk = document.createTreeWalker(document.querySelector('.transcript') ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const y = Math.min(r.bottom, pill.bottom) - Math.max(r.top, pill.top);
        if (Math.min(r.right, pill.right) - Math.max(r.left, pill.left) > 2 && y >= r.height * 0.8) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < 50; i++) {
    const pill = document.querySelector('.jump button')?.getBoundingClientRect();
    if (pill && crosses(pill)) return true;
    scrollBy({ top: 4, behavior: 'instant' });
  }
  return false;
}
