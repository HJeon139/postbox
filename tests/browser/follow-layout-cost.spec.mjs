// Changes to a transcript you follow cost no layout each (#866). The view’s change watcher read the page’s height after
// every batch of changes, and each read forced a layout of the whole page: in the person’s Firefox profile, 823 of them
// in one 72-second freeze. Chromium counts the page’s layouts (the DevTools protocol’s Performance.getMetrics):
// 50 batches of changes, each in its own microtask, now take none until the frame.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

// Tracing is off: Playwright’s trace snapshot walks the page each action, and an item the transcript skips (#712a) is
// laid out on its own when the walk reaches it, which Chromium counts as the page’s layouts (choice-layout-cost.spec.mjs).
test.use({ trace: 'off' });

const BATCHES = 50;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
test.beforeAll(async () => {
  app = await startPostbox('follow-layout-cost');
  const projectId = Object.values(app.rt.store.state.projects)[0].id;
  room = app.rt.createThread({ projectId, title: 'Followed', personaIds: [] }).id;
  for (let i = 0; i < 60; i++) app.store.emit('item.add', { threadId: room, item: { id: `it_f${i}`, at: Date.now(), kind: 'user', text: `Line ${i}` } });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#866 50 batches of changes to a followed transcript, one microtask each, force no layout of their own', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layouts = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value;
  const before = await layouts();
  // Each batch is a change inside the transcript, in its own microtask, all in one task: as a burst of events lands.
  await page.evaluate(async (n) => {
    const last = /** @type {HTMLElement} */ ([...document.querySelectorAll('#main > .item')].at(-1));
    for (let i = 0; i < n; i++) {
      await Promise.resolve();
      last.append(document.createTextNode(` ${i}`));
    }
  }, BATCHES);
  const during = (await layouts()) - before;
  test.info().annotations.push({ type: 'measured', description: `layouts during ${BATCHES} batches: ${during}` });
  expect(during, `layouts forced by ${BATCHES} batches of changes`).toBeLessThan(5);
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
});

test('#903 50 batches that each take out a node and put one in, as streaming does, force no layout of their own', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layouts = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value;
  const before = await layouts();
  // Each streamed delta takes a span out of the reply and puts new text in, in two records of one batch.
  await page.evaluate(async (n) => {
    const last = /** @type {HTMLElement} */ ([...document.querySelectorAll('#main > .item')].at(-1));
    let span = last.appendChild(document.createElement('span'));
    for (let i = 0; i < n; i++) {
      await Promise.resolve();
      span.remove();
      span = last.appendChild(document.createElement('span'));
      span.textContent = ` ${i}`;
    }
  }, BATCHES);
  const during = (await layouts()) - before;
  test.info().annotations.push({ type: 'measured', description: `layouts during ${BATCHES} remove-and-add batches: ${during}` });
  expect(during, `layouts forced by ${BATCHES} batches that remove and add`).toBeLessThan(5);
  await settled(page);
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
});
