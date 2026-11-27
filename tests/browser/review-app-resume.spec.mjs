// #1726, cause 4: a review of an app, off screen, is paused while another app is checked, and must come back when the
// check ends. Its app’s own item, far above, is unloaded while off screen, and the page kept that as the app’s id, which
// the review shares: so the review was never remounted, and stayed paused, unsized, when the person scrolled to it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const TALL = '<main style="padding:12px"><button id="b" type="button" style="display:block;width:100%;height:160px">Big</button></main>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('review-app-resume');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#1726 a review off screen, paused for another app’s check, comes back while its app’s own item stays unloaded', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Resume', personaIds: [arrange.persona(rt, 'librarian').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const lines = async (/** @type {number} */ n, /** @type {string} */ what) => {
    for (let i = 1; i <= n; i++)
      arrange.post(rt, t.id, { kind: 'user', text: `${what} ${i}: a line to give the page some length, long enough to wrap in a narrow window.` });
    await synced(page, app);
  };
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);

  // The app, then far below it a review of it, then enough below the review that it’s off screen at the end.
  tools.show_app({ id: 'reviewed', title: 'Reviewed', code: TALL, permissions: [] });
  await expect.poll(() => rt.store.state.apps.reviewed?.check.status, { message: 'the app to pass its check' }).toMatch(/^(passed|note)$/);
  await lines(80, 'Between');
  tools.show_block({ block: { id: 'rv', type: 'review', version: 1, title: 'Reviewed', fallback: 'Review the app.', format: 'app', appId: 'reviewed' } });
  const review = page.locator('.rv-box');
  await expect(review.locator('iframe.app-iframe'), 'the review’s app to load').toHaveAttribute('data-sized', '1');
  await lines(30, 'After');
  await settled(page);
  await expect(page.locator('.app-holder .app-placeholder', { hasText: 'Unloaded while off screen' }), 'the app’s own item unloaded').toHaveCount(1);
  expect(await review.evaluate((b) => b.getBoundingClientRect().bottom < 0), 'the review is off screen, above the view').toBe(true);

  // Another app is checked: the review, off screen, is paused while the check runs.
  tools.show_app({ id: 'other', title: 'Other', code: TALL, permissions: [] });
  await expect(review.locator('.app-placeholder', { hasText: 'Paused while another app is checked' }), 'paused for the check').toHaveCount(1);
  await expect.poll(() => rt.store.state.apps.other?.check.status, { message: 'the other app to pass its check' }).toMatch(/^(passed|note)$/);

  // The check is over: the review comes back, and is there when the person scrolls to it.
  await expect(review.locator('.app-placeholder', { hasText: 'Paused while another app is checked' }), 'resumed after the check').toHaveCount(0);
  await review.scrollIntoViewIfNeeded();
  await expect(review.locator('iframe.app-iframe'), 'the review’s app is drawn again').toHaveAttribute('data-sized', '1');
  await expect(page.locator('.app-holder .app-placeholder', { hasText: 'Unloaded while off screen' }), 'its app’s own item is still unloaded').toHaveCount(1);
});

test('#1726 an app paused for a check that is unloaded far off screen meanwhile stays unloaded when the check ends', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Stays unloaded',
    personaIds: [arrange.persona(rt, 'librarian').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const lines = async (/** @type {number} */ n, /** @type {string} */ what) => {
    for (let i = 1; i <= n; i++)
      arrange.post(rt, t.id, { kind: 'user', text: `${what} ${i}: a line to give the page some length, long enough to wrap in a narrow window.` });
    await synced(page, app);
  };
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  tools.show_app({ id: 'near', title: 'Near', code: TALL, permissions: [] });
  await expect.poll(() => rt.store.state.apps.near?.check.status, { message: 'the app to pass its check' }).toMatch(/^(passed|note)$/);
  await lines(8, 'After');
  await settled(page);
  // Just off screen, near enough that it’s still loaded.
  await expect(page.locator('iframe.app-iframe[title="Near"]'), 'the app is loaded').toHaveAttribute('data-sized', '1');
  const holder = page.locator('.app-holder').first();

  // The other app’s check is held open: its check pages wait until the test lets them load.
  /** @type {() => void} */
  let release = () => {};
  const released = new Promise((r) => {
    release = () => r(undefined);
  });
  await page.route('**/sandbox/app/held/**', async (route) => {
    if (route.request().url().includes('check')) await released;
    await route.continue();
  });
  tools.show_app({ id: 'held', title: 'Held', code: TALL, permissions: [] });
  await expect(holder.locator('.app-placeholder', { hasText: 'Paused while another app is checked' }), 'paused for the check').toHaveCount(1);
  // Meanwhile the room grows and the view follows it, far from the app, which unloads.
  await lines(80, 'Later');
  await settled(page);
  await expect(holder.locator('.app-placeholder', { hasText: 'Unloaded while off screen' }), 'unloaded while the check runs').toHaveCount(1);
  release();
  await expect.poll(() => rt.store.state.apps.held?.check.status, { message: 'the other app to pass its check', timeout: 30_000 }).toMatch(/^(passed|note)$/);
  await settled(page);
  await expect(holder.locator('.app-placeholder', { hasText: 'Unloaded while off screen' }), 'still unloaded: the check’s end doesn’t reload it').toHaveCount(
    1,
  );
  await expect(holder.locator('iframe.app-iframe'), 'no frame far off screen').toHaveCount(0);
});
