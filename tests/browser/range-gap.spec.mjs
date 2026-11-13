// A load past an edge, queued behind a load that replaces the range, is for the range the page holds when it runs
// (#1155, from the integrator's review): built when it was asked for, its edge was the old range's, and its answer was
// joined to the new range though they didn't touch, leaving an item out of what the page held.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, newestShown, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('range-gap');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#1155 an app moved forward while you scroll back leaves the loaded range one run of the room', async ({ page }) => {
  const projectId = /** @type {any} */ (Object.values(app.rt.store.state.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: 'A long room', personaIds: [] }).id;
  seedBigRoom(app.store, room, { count: 1000 });
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await newestShown(page, app, room);
  await settled(page);
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  let held = false;
  // The reload of the latest range that the move causes is held.
  await page.route(`**/api/threads/${room}/items?limit=200`, async (route) => {
    held = true;
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  // An app far back in the room is updated, which moves it to the newest point (runtime.bringForward).
  arrange.moveToEnd(app.rt, room, app.store.items(room)[10].id, { what: 'app', title: 'Chart' });
  await expect.poll(() => held).toBe(true);
  // Meanwhile the window asks for the range before what's loaded, as a scroll to its top does.
  await page.evaluate((t) => import('/app/js/open-threads.mjs').then((m) => m.grow(t, 'before')), room);
  release();
  const holds = () =>
    page.evaluate(
      (t) =>
        import('/app/js/client.mjs').then(({ client }) => {
          const r = client.ranges.get(t);
          return { loads: r?.loads ?? 0, start: r?.start ?? 0, ids: (client.state.items[t] ?? []).map((x) => x.id) };
        }),
      room,
    );
  await expect.poll(async () => (await holds()).loads, 'every load has landed').toBe(0);
  await settled(page);
  const got = await holds();
  const want = app.store
    .items(room)
    .map((x) => x.id)
    .slice(got.start, got.start + got.ids.length);
  expect(got.ids, 'the page holds one run of the room, where its range says it starts').toEqual(want);
});
