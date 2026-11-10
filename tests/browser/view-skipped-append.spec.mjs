// A reply arriving while the view follows the newest message moves the view once (#712a). Items off screen lay out
// at an estimate (`content-visibility: auto`, app/workbench.css), and an item appended below the view starts off
// screen. Laid out at its estimate first and at its real height a frame later, it made the following view scroll twice,
// a frame apart, so what was under the pointer moved a frame late: app-send.spec.mjs’s click on an app missed its button
// when a sent line landed under the app just before the click.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-append');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

// Far taller than the 71 px estimate, so a layout at the estimate and one at its real height scroll to different places.
const TALL = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a long reply that arrives while you follow.`).join('\n\n');

test('#712a: a reply appended while following scrolls to the end once, at its real height', async ({ page }) => {
  const { rt, store } = app;
  const t = bigRoom(app, 'Following as a reply lands', 60);
  const [se] = rt.sessionsIn(t.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(store.items(t.id).length);
  await still(page);
  await expect(page.locator(`.transcript[data-thread="${t.id}"]`)).toHaveAttribute('data-view-mode', 'following');
  // Each frame’s scroll position, from before the reply lands until well after it has drawn.
  await page.evaluate(() => {
    const tops = [scrollY];
    /** @type {any} */ (window).__tops = tops;
    const tick = () => {
      tops.push(scrollY);
      if (tops.length < 90) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const reply = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: TALL, status: 'done' });
  await expect(page.locator(`[data-key="${reply.id}"]`)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__tops.length), { timeout: 10_000 }).toBeGreaterThanOrEqual(90);
  const tops = await page.evaluate(() => /** @type {number[]} */ (/** @type {any} */ (window).__tops));
  const moves = tops.slice(1).filter((y, i) => Math.abs(y - tops[i]) >= 1).length;
  expect(moves, `the view’s scroll position, frame by frame: ${tops.join(' ')}`).toBe(1);
  const end = await page.evaluate(() => Math.abs(document.scrollingElement.scrollHeight - innerHeight - scrollY));
  expect(end, 'and it ends at the end').toBeLessThan(2);
});

test('#712a: once painted and skipped again, the appended reply keeps its real height, so a later scroll holds', async ({ page }) => {
  const { rt, store } = app;
  const t = bigRoom(app, 'The reply goes off screen', 60);
  const [se] = rt.sessionsIn(t.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(store.items(t.id).length);
  await still(page);
  const reply = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: TALL, status: 'done' });
  const node = page.locator(`[data-key="${reply.id}"]`);
  await expect(node).toBeInViewport();
  await still(page);
  const drawn = await node.evaluate((n) => n.getBoundingClientRect().height);
  expect(drawn, 'drawn at its real height, well over the estimate').toBeGreaterThan(300);
  // Off screen: the reply is skipped again (its content is: the item is the box content-visibility applies to, so its
  // own checkVisibility() stays true, as tools/uat/skip-probe.mjs says), and holds the size it was painted at, not the 71 px estimate.
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => node.evaluate((n) => !n.firstElementChild?.checkVisibility({ contentVisibilityAuto: true }))).toBe(true);
  expect(await node.evaluate((n) => n.getBoundingClientRect().height)).toBeCloseTo(drawn, 0);
});

test('#712a: a reply appended while reading higher up stays skipped, and the view doesn’t move', async ({ page }) => {
  const { rt, store } = app;
  const t = bigRoom(app, 'Reading as a reply lands', 60);
  const [se] = rt.sessionsIn(t.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(store.items(t.id).length);
  await still(page);
  await page.locator('header.topbar').hover();
  await page.mouse.wheel(0, -2400);
  await still(page);
  const tr = page.locator(`.transcript[data-thread="${t.id}"]`);
  await expect(tr).toHaveAttribute('data-view-mode', 'reading');
  const before = await page.evaluate(() => scrollY);
  const reply = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: TALL, status: 'done' });
  const node = page.locator(`[data-key="${reply.id}"]`);
  await expect(node).toHaveCount(1);
  await still(page);
  // Never drawn, it still lays out at its estimate: drawing it once (the newest-item draw, view-state.mjs grew(), which
  // is only while following) would have it keep its painted height of several hundred pixels.
  expect(await node.evaluate((n) => n.getBoundingClientRect().height), 'the reply below was never drawn').toBeLessThan(100);
  expect(await page.evaluate(() => scrollY), 'what you read stays where it was').toBe(before);
  expect(await node.evaluate((n) => !n.firstElementChild?.checkVisibility({ contentVisibilityAuto: true })), 'the reply below is skipped').toBe(true);
});

test('#712a: a burst of replies appended while following draws one at a time, not every one so far', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const { rt, store } = app;
  const t = bigRoom(app, 'A burst lands while following', 60);
  const [se] = rt.sessionsIn(t.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(store.items(t.id).length);
  await still(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name)?.value ?? 0;
  // How many items are drawn by force at once (style content-visibility: visible), at most, through the burst.
  await page.evaluate((threadId) => {
    const tr = document.querySelector(`.transcript[data-thread="${threadId}"]`);
    const state = { most: 0 };
    /** @type {any} */ (window).__forced = state;
    new MutationObserver(() => {
      const n = [...tr.children].filter((c) => /** @type {HTMLElement} */ (c).style.contentVisibility === 'visible').length;
      state.most = Math.max(state.most, n);
    }).observe(tr, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  }, t.id);
  const BURST = 300;
  const [count0, time0] = [await metric('LayoutCount'), await metric('LayoutDuration')];
  for (let i = 0; i < BURST; i++)
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: `Burst reply ${i}.`, status: 'done' });
  await synced(page, app);
  await still(page);
  const most = await page.evaluate(() => /** @type {any} */ (window).__forced.most);
  const layouts = (await metric('LayoutCount')) - count0;
  const seconds = (await metric('LayoutDuration')) - time0;
  // One drawn at a time: 300 appends take about one layout each (305 measured), where every reply staying drawn took
  // two (602) and five times the layout time (#712a).
  const seen = `${most} drawn at once, ${layouts} layouts, ${seconds.toFixed(3)} s of layout`;
  expect(most, `replies drawn by force at once: ${seen}`).toBeLessThanOrEqual(1);
  expect(layouts, `Chromium’s LayoutCount for the burst: ${seen}`).toBeLessThan(BURST * 1.5);
});

// Firefox moved the view up as the room's items drew shorter than their 71 px estimate, and the room opened reading
// (the Mac's Firefox, and Linux Firefox with these fonts). It opens following, in each browser.
test('#712a: a room of items shorter than their estimates opens following', async ({ page }) => {
  const t = bigRoom(app, 'Shorter than estimates', 60);
  await page.addInitScript(() =>
    addEventListener('DOMContentLoaded', () =>
      document.head.append(
        Object.assign(document.createElement('style'), { textContent: '.transcript .item { line-height: 1.05 !important; font-size: 12px !important }' }),
      ),
    ),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > .item`)).toHaveCount(app.store.items(t.id).length);
  await still(page);
  await expect(page.locator(`.transcript[data-thread="${t.id}"]`)).toHaveAttribute('data-view-mode', 'following');
});
