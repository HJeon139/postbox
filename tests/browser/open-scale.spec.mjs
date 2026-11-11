// What a room costs the page as its history grows (#1155, #532): the page loads what it draws, so loading the page
// (bytes, items held, elements) stays flat from 1,000 items to 100,000, where holding every item grew with the room,
// and going to the room from another costs what it did: two layouts, its newest item painted as soon. The scale
// targets are 10x to 100x real use, a room of about 28,000 items and up; each size runs on a server of its own, so the
// page's state carries that room alone.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, newestShown, startPostbox, synced } from './postbox.mjs';

const SIZES = [1_000, 10_000, 28_000, 100_000];
/** @type {Record<number, { bytes: number, held: number, elements: number, switchMs: number, layouts: number }>} */
const cost = {};

failOnPageErrors(test);
test.describe.configure({ mode: 'serial' });

/** Goes to a conversation by its address, and how long until its newest item is on the page and painted, in ms. */
const switchTo = (page, threadId, last) =>
  page.evaluate(
    ([t, k]) =>
      new Promise((done) => {
        const t0 = performance.now();
        location.hash = `#/t/${t}`;
        const seen = () => {
          if (!document.querySelector(`.transcript[data-thread="${t}"] > [data-key="${k}"]`)) return requestAnimationFrame(seen);
          // The frame after it was added is the one that painted it.
          requestAnimationFrame(() => done(Math.round(performance.now() - t0)));
        };
        seen();
      }),
    [threadId, last],
  );

for (const count of SIZES)
  test(`#1155 a room of ${count.toLocaleString('en-US')} items`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the layouts come from Chromium’s DevTools protocol');
    test.setTimeout(300_000);
    const app = await startPostbox(`open-scale-${count}`);
    try {
      const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
      const room = app.rt.createThread({ projectId, title: `${count} items`, personaIds: [] });
      const other = app.rt.createThread({ projectId, title: 'A short room', personaIds: [] });
      seedBigRoom(app.store, room.id, { count });
      app.rt.addItem(other.id, { kind: 'user', text: 'Elsewhere' });
      let bytes = 0;
      page.on('response', async (r) => {
        if (!/\/api\/(state|threads\/[^/]+\/items)/.test(r.url())) return;
        // The size on the wire, from the request's own record: a body of many megabytes can't be handed back whole.
        bytes += (await r.request().sizes()).responseBodySize;
      });
      await page.goto(`${app.origin}/#/t/${room.id}`);
      await synced(page, app);
      await newestShown(page, app, room.id);
      const held = await page.evaluate(() =>
        import('/app/js/client.mjs').then(({ client }) => Object.values(client.state.items).reduce((n, l) => n + /** @type {any[]} */ (l).length, 0)),
      );
      const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
      // Then to the room from another, as the person switches: twice, the second measured.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const layoutsNow = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
      const last = app.store.items(room.id).at(-1).id;
      let switchMs = 0;
      let layouts = 0;
      for (let i = 0; i < 2; i++) {
        await switchTo(page, other.id, app.store.items(other.id).at(-1).id);
        const before = await layoutsNow();
        switchMs = await switchTo(page, room.id, last);
        layouts = (await layoutsNow()) - before;
      }
      cost[count] = { bytes, held, elements, switchMs, layouts };
      test.info().annotations.push({ type: 'measured', description: JSON.stringify(cost[count]) });
      console.log(`OPEN ${count} ${JSON.stringify(cost[count])}`);
      expect(layouts, 'layouts going to the room, as many as on main').toBeLessThanOrEqual(2);
    } finally {
      // The page goes first, so its stream doesn't see the server leave.
      await page.close();
      await app.stop();
    }
  });

test('#1155 loading the page costs no more for a room 100 times longer', () => {
  const small = cost[SIZES[0]];
  const big = cost[SIZES.at(-1) ?? 0];
  expect(small && big, 'every size measured').toBeTruthy();
  const all = JSON.stringify(cost);
  expect(big.bytes, `bytes loaded: ${all}`).toBeLessThan(small.bytes * 2);
  expect(big.held, `items held: ${all}`).toBeLessThan(small.held * 2);
  expect(big.elements, `elements: ${all}`).toBeLessThan(small.elements * 2);
  expect(big.switchMs, `ms to the newest item, going to the room: ${all}`).toBeLessThan(small.switchMs * 2 + 50);
});
