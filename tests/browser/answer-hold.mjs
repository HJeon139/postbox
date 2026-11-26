// #518: holding a block’s answer on its way, so a test can revise the block before the answer settles, and taking the
// page away from the block meanwhile, so it never draws the answered revision.

import { expect } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { synced } from './postbox.mjs';

/** A gate a test opens: wait() resolves once open() is called. */
export function gate() {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((r) => {
    open = () => r(undefined);
  });
  return { open, wait: () => opened };
}

/**
 * Holds a block’s answer on its way: its reply to the page until release(), and, with untilSent, the request itself
 * until send(). @param {import('@playwright/test').Page} page @param {string} threadId @param {string} itemId
 */
export async function holdAct(page, threadId, itemId, { untilSent = false } = {}) {
  const sent = gate();
  const released = gate();
  if (!untilSent) sent.open();
  await page.route(`**/api/threads/${threadId}/items/${itemId}/act`, async (route) => {
    await sent.wait();
    const response = await route.fetch();
    await released.wait();
    await route.fulfill({ response });
  });
  return { send: sent.open, release: released.open };
}

/**
 * Opens another conversation, once the page knows it: until then the page stays where it is.
 * @param {import('@playwright/test').Page} page @param {any} app @param {string} projectId
 */
export async function away(page, app, projectId) {
  const elsewhere = app.rt.createThread({ projectId, title: 'Elsewhere', personaIds: [arrange.persona(app.rt, 'researcher').id] });
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${elsewhere.id}`);
  await expect(page, 'the page is in the other conversation').toHaveURL(new RegExp(`#/t/${elsewhere.id}$`));
}

/**
 * Back to the room, once the page has heard all that happened there meanwhile, so it draws the room as it is now and
 * not what it last heard. @param {import('@playwright/test').Page} page @param {any} app @param {string} threadId
 */
export async function back(page, app, threadId) {
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${threadId}`);
  await synced(page, app);
}
