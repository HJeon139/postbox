// The transcript window on by default (#866, the person’s choice of 8 Nov): a conversation longer than the window’s
// ceiling mounts only the items around the view with no flag set, a shorter one mounts every item, and the flag set
// to 'off' mounts every item, as before. The window budgets elements as well as items (#1155, item 2): a room of
// tables stays within #1166’s 5,000 elements for the whole page, opening and scrolling up.

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
// #1166’s budget for every element on the page.
const ELEMENTS = 5000;
// A room of tables of ten rows, each about 100 elements: the item ceiling alone let 240 of them mount, about 24,000.
const TABLES = 600;

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
  const t = app.rt.createThread({ projectId, title: 'Tables', personaIds: [app.rt.personaByHandle('librarian').id] });
  const se = app.rt.sessionsIn(t.id)[0];
  const columns = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase() }));
  const rows = Array.from({ length: 10 }, (_, r) => ({ id: `r${r}`, cells: Object.fromEntries(columns.map((c) => [c.id, `${c.id}${r}`])) }));
  for (let i = 0; i < TABLES; i++) {
    const block = { id: `tb${i}`, type: 'table', version: 1, title: `Table ${i}`, fallback: `Table ${i}`, columns, rows };
    app.store.emit('item.add', {
      threadId: t.id,
      item: { id: `it_tb${i}`, at: 1_700_000_000_000 + i, kind: 'block', handle: se.handle, sessionId: se.id, valid: true, block },
    });
  }
  rooms.tables = t.id;
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Opens a room with the flag as given (null: never set), and waits for it to hold still. @param {number | 'tables'} count */
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

test('#1155 a room of tables keeps the whole page within 5,000 elements, opening and scrolling up', async ({ page }) => {
  await open(page, 'tables', null);
  const elements = () => page.evaluate(() => document.getElementsByTagName('*').length);
  expect.soft(await elements(), 'opening').toBeLessThanOrEqual(ELEMENTS);
  let most = 0;
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, -2500);
    await settled(page);
    most = Math.max(most, await elements());
  }
  expect.soft(most, 'scrolling up').toBeLessThanOrEqual(ELEMENTS);
  // It did scroll: the newest table has left the page.
  await expect(page.locator(`#main > .item[data-key="it_tb${TABLES - 1}"]`)).toHaveCount(0);
});
