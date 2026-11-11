// The transcript window on by default (#866, the person’s choice of 8 Nov): a conversation longer than the window’s
// ceiling mounts only the items around the view with no flag set, a shorter one mounts every item, and the flag set
// to 'off' mounts every item, as before.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

// The window’s ceiling (window-limits.mjs): a room at or under it mounts whole.
const CEILING = 240;
const SHORT = 200;
// Twice the ceiling, so a room mounted whole can’t pass the bounded case, and small enough to mount whole and sync
// within expect’s 5 s: 1,500 items mounted whole didn’t, on the build host.
const LONG = 500;
// Over the ceiling, for the window off: the smallest room the window would hold, so mounting it whole syncs within
// expect’s 5 s on a loaded host (500 mounted whole didn’t, once, at load 15).
const OFF = 300;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {Record<number, string>} */
const rooms = {};
test.beforeAll(async () => {
  app = await startPostbox('window-default');
  const projectId = Object.values(app.rt.s.projects)[0].id;
  for (const count of [SHORT, OFF, LONG]) {
    const t = app.rt.createThread({ projectId, title: `${count} items`, personaIds: [] });
    seedBigRoom(app.store, t.id, { count });
    rooms[count] = t.id;
  }
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Opens a room with the flag as given (null: never set), and waits for it to hold still. */
async function open(page, count, flag) {
  await page.addInitScript((value) => (value === null ? localStorage.removeItem('pb-window') : localStorage.setItem('pb-window', value)), flag);
  await page.goto(`${app.origin}/#/t/${rooms[count]}`);
  // The page loads all three rooms, 1,000 items, before it hears the latest event: under the full suite’s load with
  // events 300 ms late that took past synced()’s 5 s in CI, as view-skipped-tab.spec.mjs found.
  await synced(page, app, 15_000);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
}
const mounted = (page) => page.locator('#main > .item').count();

test('#866 with no flag set, a long room mounts no more than the window’s ceiling, and shows its newest item', async ({ page }) => {
  await open(page, LONG, null);
  expect(await mounted(page)).toBeLessThanOrEqual(CEILING);
  const last = app.store.items(rooms[LONG]).at(-1).id;
  await expect(page.locator(`#main > .item[data-key="${last}"]`)).toBeInViewport();
});

test('#866 with no flag set, a short room mounts every item', async ({ page }) => {
  await open(page, SHORT, null);
  expect(await mounted(page)).toBe(app.store.items(rooms[SHORT]).length);
});

test('#866 with the flag off, a room over the ceiling mounts every item, as before', async ({ page }) => {
  await open(page, OFF, 'off');
  expect(await mounted(page)).toBe(app.store.items(rooms[OFF]).length);
});
