// The tidy-text check (#681, app/kit/check-text.js) and a box that scrolls (#1985): text that a scroll box has scrolled
// past the window’s edge is clipped by that box, and scrolling reaches it, so it isn’t cut off. Text past the window’s
// edge with nothing to scroll it into view still is, and so is text an overflow: hidden box cuts.

import { expect, test } from '@playwright/test';
import { textLayout } from './text-layout.mjs';

const STYLE = '<style>body { margin: 0; font: 16px/1.4 sans-serif; background: #fff; color: #111; }</style>';

// A scroll box 100 px from the window’s top, scrolled so a label inside it sits across the window’s top edge: it lies
// above the box’s own top, which clips it, as a long persona sheet’s body scrolled “Instructions” there (#1985).
const SCROLLED = `${STYLE}
<div id="box" style="position: fixed; top: 100px; left: 16px; right: 16px; height: 200px; overflow: auto">
  <div style="height: 500px"></div>
  <label id="label" style="display: block">Instructions</label>
  <div style="height: 800px"></div>
</div>`;

// The same label past the window’s top, by more than a third of its line, with nothing that scrolls it into view: the
// page’s edge cuts it.
const PAST_EDGE = `${STYLE}<label style="position: absolute; top: -12px; left: 16px">Instructions</label>`;

// A box that hides its overflow and cuts a label in two at its bottom edge.
const HIDDEN = `${STYLE}
<div style="position: fixed; top: 100px; left: 16px; width: 300px; height: 30px; overflow: hidden">
  <div style="height: 20px"></div>
  <label style="display: block">Instructions</label>
</div>`;

// An overflow: hidden cell that cuts its label, in a row a scroll box has scrolled out of view: still reported.
const HIDDEN_ROW = `${STYLE}
<div id="box" style="position: fixed; top: 100px; left: 16px; width: 300px; height: 60px; overflow: auto">
  <div style="height: 400px"></div>
  <div style="width: 80px; overflow: hidden; white-space: nowrap">A cell label far too long for its cell</div>
</div>`;

// A scroll box partly above the window’s top, scrolled a little, so its first label sits across the window’s top edge
// while the box shows part of it: the box scrolled it there, so scrolling reaches it.
const PARTLY = `${STYLE}
<div id="box" style="position: fixed; top: 5px; left: 16px; right: 16px; height: 200px; overflow: auto">
  <div style="height: 30px"></div>
  <label style="display: block">Instructions</label>
  <div style="height: 800px"></div>
</div>`;

// A body whose overflow the window owns (the root’s is visible), as many apps set, and a label past the window’s top:
// the body scrolls nothing, so the page’s edge still cuts the label.
const BODY_OWNED = `<style>body { margin: 0; font: 16px/1.4 sans-serif; overflow-x: hidden }</style>
<label style="position: absolute; top: -12px; left: 16px">Instructions</label>`;

const cutOff = async (page) => (await textLayout(page)).filter((p) => p.code === 'text-cut-off').map((p) => p.message);

for (const width of [375, 1280]) {
  test(`#1985 at ${width} px a label a scroll box scrolled past the window’s edge isn’t cut off: scrolling reaches it`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(SCROLLED);
    const top = await page.evaluate(() => {
      const box = /** @type {HTMLElement} */ (document.getElementById('box'));
      box.scrollTop = 610;
      return /** @type {HTMLElement} */ (document.getElementById('label')).getBoundingClientRect().top;
    });
    expect(top, 'the label sits across the window’s top edge').toBeLessThan(0);
    expect(await cutOff(page)).toEqual([]);
  });

  test(`#1985 at ${width} px a label past the window’s edge with nothing to scroll is still cut off by the page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(PAST_EDGE);
    expect(await cutOff(page)).toEqual([expect.stringContaining('is cut off by the page’s edge')]);
  });

  test(`#1985 at ${width} px a label an overflow: hidden box cuts is still cut off by that box`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(HIDDEN);
    const found = await cutOff(page);
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('the page’s edge');
  });

  test(`#1985 at ${width} px a cut inside a row a scroll box shows none of is still reported`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(HIDDEN_ROW);
    expect(await cutOff(page)).toEqual([expect.stringContaining('A cell label far too long')]);
  });

  test(`#1985 at ${width} px a label a scroll box shows part of, across the window’s top, isn’t cut off`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(PARTLY);
    await page.evaluate(() => {
      /** @type {HTMLElement} */ (document.getElementById('box')).scrollTop = 48;
    });
    expect(await cutOff(page)).toEqual([]);
  });

  test(`#1985 at ${width} px a body whose overflow the window owns doesn’t hide a cut at the page’s edge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(BODY_OWNED);
    expect(await cutOff(page)).toEqual([expect.stringContaining('is cut off by the page’s edge')]);
  });
}
