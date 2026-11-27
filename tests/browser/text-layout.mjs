// The layout check of Postbox’s own screens in a browser spec (#681, tools/text-layout.mjs): text drawn over text or
// run into a control, text cut off by its box, and words broken mid-word. A spec that calls expectTidyText fails on
// any of them.

import { expect } from '@playwright/test';
import { TEXT_LAYOUT } from '../../tools/text-layout.mjs';

/**
 * The layout problems on the page at its window’s width, as { code, message }. Measuring takes about a second, as text
 * over text is measured twice.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ code: string, message: string }[]>}
 */
export const textLayout = (page) => page.evaluate(TEXT_LAYOUT);

/**
 * Fails when the page shows any layout problem, naming each.
 * @param {import('@playwright/test').Page} page  @param {string} [where]  what the page shows, for the failure
 */
export async function expectTidyText(page, where = 'the page') {
  const found = await textLayout(page);
  expect(
    found.map((p) => p.message),
    `${where} has no text over text or a control, cut off or broken mid-word (#681)`,
  ).toEqual([]);
}
