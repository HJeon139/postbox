// The Stop ask of tests/browser/stop.spec.mjs: Stop on @developer’s reply, the ask it opens, a background job’s own
// Stop, and how a test answers the ask with Keep running.

import { expect } from '@playwright/test';

/** @typedef {import('@playwright/test').Page} Page */

/** @param {Page} page */
export const stopButton = (page) => page.locator('.composer').getByRole('button', { name: 'Stop developer’s reply', exact: true });
/** @param {Page} page */
export const ask = (page) => page.locator('.stop-ask');
/** @param {Page} page @param {string} name */
export const choice = (page, name) => ask(page).getByRole('button', { name, exact: true });
export const UAT = 'Run the mixed-room UAT scenario live';
/** A background job’s own Stop, by the job’s label. @param {Page} page */
export const jobStop = (page, label = UAT) => page.locator('.bg-jobs').getByRole('button', { name: `Stop the background job “${label}”`, exact: true });
/** Stops the agent and keeps its jobs running, from the ask’s second choice, and waits for its process to exit. @param {Page} page @param {() => Promise<void>} idle */
export async function keepRunning(page, idle) {
  await stopButton(page).click();
  await expect(ask(page)).toBeVisible();
  await choice(page, 'Keep running').click();
  await idle();
}
