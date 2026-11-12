// What a room costs the page as its history grows (#1155, #532): the page loads what it draws, so loading the page
// (bytes, items held, elements) stays flat from 1,000 items to 100,000, where holding every item grew with the room,
// and going back to the room from another costs what it did: two layouts, nothing loaded, its newest item painted as
// soon. The scale targets are 10x to 100x real use, a room of about 28,000 items and up; each size runs on a server of
// its own, so the page's state carries that room alone. The time to the newest item is measured apart, on one server and
// page holding a short room and a long one, so whatever slows the machine slows both alike (#1271).

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, newestShown, startPostbox, synced } from './postbox.mjs';

const SIZES = [1_000, 10_000, 28_000, 100_000];
/** @type {Record<number, { bytes: number, held: number, elements: number, layouts: number, switchBytes: number }>} */
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
      let layouts = 0;
      let switchBytes = 0;
      const loaded = bytes;
      for (let i = 0; i < 2; i++) {
        await switchTo(page, other.id, app.store.items(other.id).at(-1).id);
        const before = await layoutsNow();
        const bytesBefore = bytes;
        await switchTo(page, room.id, last);
        layouts = (await layoutsNow()) - before;
        switchBytes = bytes - bytesBefore;
      }
      cost[count] = { bytes: loaded, held, elements, layouts, switchBytes };
      test.info().annotations.push({ type: 'measured', description: JSON.stringify(cost[count]) });
      console.log(`OPEN ${count} ${JSON.stringify(cost[count])}`);
      expect(layouts, 'layouts going to the room, as many as on main').toBeLessThanOrEqual(2);
      // Back to a room left a moment ago: it's warm (open-threads.mjs), so nothing is loaded, as on main.
      expect(switchBytes, 'bytes loaded going back to the room').toBe(0);
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
});

/** The middle one of some times. @param {number[]} ms */
const median = (ms) => [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)];

// One slow reading on a busy runner failed the time bar when each size ran on a server of its own, in a test of its own
// (#1271): both rooms here share one server and page, and the switches to them take turns, so what slows the machine
// slows both alike, and the middle of seven readings leaves out a slow one. Work that grows with the room still shows.
test('#1271 going to a room 100 times longer is as quick as going to a short one', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await startPostbox('open-scale-switch');
  try {
    const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
    const rooms = [SIZES[0], SIZES.at(-1) ?? 0].map((count) => {
      const room = app.rt.createThread({ projectId, title: `${count} items`, personaIds: [] });
      seedBigRoom(app.store, room.id, { count });
      return { count, id: room.id, last: app.store.items(room.id).at(-1).id, ms: /** @type {number[]} */ ([]) };
    });
    const other = app.rt.createThread({ projectId, title: 'A short room', personaIds: [] });
    const elsewhere = app.rt.addItem(other.id, { kind: 'user', text: 'Elsewhere' });
    await page.goto(`${app.origin}/#/t/${other.id}`);
    await synced(page, app);
    // Each room opened once first, so every switch measured goes back to a warm room, as in the tests above.
    for (const room of rooms) {
      await switchTo(page, room.id, room.last);
      await switchTo(page, other.id, elsewhere.id);
    }
    for (let i = 0; i < 7; i++)
      for (const room of rooms) {
        room.ms.push(await switchTo(page, room.id, room.last));
        await switchTo(page, other.id, elsewhere.id);
      }
    const [small, big] = rooms;
    const all = JSON.stringify(Object.fromEntries(rooms.map((r) => [r.count, r.ms])));
    test.info().annotations.push({ type: 'measured', description: all });
    console.log(`SWITCH ${all}`);
    // Within a frame or so of twice the short room's time: a 60 Hz frame is 17 ms.
    expect(median(big.ms), `ms to the newest item, going to the room: ${all}`).toBeLessThan(median(small.ms) * 2 + 17);
  } finally {
    await page.close();
    await app.stop();
  }
});
