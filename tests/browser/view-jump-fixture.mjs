// What the jump specs share (#712a): a 10,000-item room opened at its end, a jump through jumpTo
// (app/js/view-jump.mjs), a wait for what it brought near to draw, and where the target landed against where its block
// puts it.

import { expect } from '@playwright/test';
import { synced } from './postbox.mjs';
import { quiet, still } from './view-skipped-fixture.mjs';

/** Items in each room the jump specs make. */
export const COUNT = 10_000;

/** Opens a room at its end, with every item mounted, and waits for it to hold still. */
export async function openRoom(app, page, conv) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  // The items first: the page takes longer than synced()'s wait to load a room this size, with the events late.
  await expect(page.locator('#main.transcript > .item')).toHaveCount(COUNT, { timeout: 60_000 });
  await synced(page, app);
  await still(page, 30_000);
}

/**
 * Jumps to an item of #main through jumpTo, and returns its key. at: its index, from the end when negative, or
 * 'diagram' for the first item with a diagram from index 3,000.
 * @param {any} page @param {number | 'diagram'} at @param {'start' | 'center' | 'nearest'} block
 */
export const jump = (page, at, block) =>
  page.evaluate(
    async ({ at, block }) => {
      const items = [...document.querySelectorAll('#main.transcript > .item')];
      const i = at === 'diagram' ? items.findIndex((n, k) => k >= 3000 && n.querySelector('figure.diagram')) : at < 0 ? items.length + at : at;
      const n = /** @type {HTMLElement} */ (items[i]);
      (await import('/app/js/view-jump.mjs')).jumpTo(n, block);
      return /** @type {string} */ (n.dataset.key);
    },
    { at, block },
  );

/** Waits for the page to hold still after a jump: for two frames, then for no item to change size in five. */
export async function landed(page) {
  await still(page, 30_000);
  await quiet(page);
  await still(page, 30_000);
}

/**
 * Where the target is, where its block puts it at its drawn height, and the view.
 * @param {any} page @param {string} key @param {'start' | 'center'} block
 */
export const where = (page, key, block) =>
  page.evaluate(
    ({ key, block }) => {
      const el = /** @type {HTMLElement} */ (document.querySelector('#main.transcript'));
      const r = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${CSS.escape(key)}"]`)).getBoundingClientRect();
      const s = /** @type {Element} */ (document.scrollingElement);
      return {
        top: r.top,
        height: r.height,
        want: block === 'start' ? 0 : Math.max(0, (innerHeight - r.height) / 2),
        scrollY,
        atEnd: s.scrollHeight - s.scrollTop - s.clientHeight <= 2,
        mode: el.dataset.viewMode,
        anchor: el.dataset.viewAnchor,
      };
    },
    { key, block },
  );

/**
 * Checks the target is where its block puts it, within 1 px, or as near as the page lets it be: at the page's start
 * (scrollY 0) it can't come further down, and at its end it can't go further up. Returns which, for the annotation.
 * @param {Awaited<ReturnType<typeof where>>} v
 */
export function placed(v) {
  if (Math.abs(v.top - v.want) <= 1) return 'placed';
  const off = `the target's top is ${v.top.toFixed(1)}, ${(v.top - v.want).toFixed(1)} px from ${v.want.toFixed(1)}`;
  if (v.scrollY === 0) {
    expect(v.top, `${off}, at the page's start, so it can only be higher than its block puts it`).toBeLessThan(v.want);
    return 'clamped at the start';
  }
  expect(v.atEnd, `${off}, and the page is at neither its start nor its end`).toBe(true);
  expect(v.top, `${off}, at the page's end, so it can only be lower than its block puts it`).toBeGreaterThan(v.want);
  expect(v.top, `${off}, at the page's end, and in view`).toBeLessThan(800);
  return 'clamped at the end';
}
