// The transcript window, W1 (#866): with its flag on, a long conversation mounts only the items around the view, so
// the page holds about the same number of elements however long the room is, and the range grows as you scroll up
// without moving what you’re reading. With the flag off, every item is mounted, as before.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const SMALL = 500;
// Six times SMALL, and no more: each case loads every room’s events, and a loaded runner must sync them within
// expect’s 5 s (5,000 items timed out at load 17 on the build host). And no less than many times the window’s CEILING
// (240, window-limits.mjs): a room at or below it mounts whole, and the bounded-range case would pass with no window.
const LARGE = 3000;
// Over the ceiling, for the window off: the smallest room the window would hold, so mounting it whole syncs within
// expect’s 5 s on CI’s runners, where 500 mounted whole didn’t (window-default.spec.mjs has the same).
const OFF = 300;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {Record<number, string>} */
const rooms = {};
test.beforeAll(async () => {
  app = await startPostbox('window-w1');
  const projectId = Object.values(app.rt.store.state.projects)[0].id;
  for (const count of [OFF, SMALL, LARGE]) {
    const t = app.rt.createThread({ projectId, title: `${count} items`, personaIds: [] });
    seedBigRoom(app.store, t.id, { count });
    rooms[count] = t.id;
  }
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Opens a room, with the window’s flag on or off, and waits for it to hold still. */
async function open(page, count, on) {
  await page.addInitScript((flag) => (flag ? localStorage.setItem('pb-window', 'on') : localStorage.setItem('pb-window', 'off')), on);
  await page.goto(`${app.origin}/#/t/${rooms[count]}`);
  // A room mounted whole, with the window off, can take CI’s loaded runners past expect’s 5 s to hear (#1075’s CI),
  // so 15 s, as gap-read-cost and window-w2’s burst allow.
  await synced(page, app, 15_000);
  await expect(page.locator('#main .item').last()).toBeVisible();
  await settled(page);
}

const counted = (page) =>
  page.evaluate(() => ({
    elements: document.querySelectorAll('#main *').length,
    items: document.querySelectorAll('#main > .item').length,
  }));

test('#866 with the window on, a 3,000-item room holds about as many elements as a 500-item one, and shows its newest item', async ({ page }) => {
  await open(page, SMALL, true);
  const small = await counted(page);
  await open(page, LARGE, true);
  const large = await counted(page);
  test.info().annotations.push({ type: 'measured', description: `elements ${small.elements} → ${large.elements}; items ${small.items} → ${large.items}` });
  expect(large.items, 'a bounded range, not every item').toBeLessThanOrEqual(240);
  expect(Math.abs(large.elements - small.elements) / small.elements, `elements: ${small.elements} at ${SMALL}, ${large.elements} at ${LARGE}`).toBeLessThan(
    0.1,
  );
  await expect(page.locator('#main')).toHaveAttribute('data-view-mode', 'following');
  const last = app.store.items(rooms[LARGE]).at(-1).id;
  await expect(page.locator(`#main > .item[data-key="${last}"]`)).toBeInViewport();
});

// With the window off, a room mounts every item: window-default.spec.mjs, in a room small enough to mount whole.

for (const on of [false, true])
  test(`#866 with the window ${on ? 'on' : 'off'}, a message sent into the open room appears at the end`, async ({ page }) => {
    const count = on ? SMALL : OFF;
    await open(page, count, on);
    const text = `A new message, window ${on ? 'on' : 'off'}`;
    app.store.emit('item.add', { threadId: rooms[count], item: { id: `it_new_${on}`, at: Date.now(), kind: 'user', text } });
    await synced(page, app, 15_000);
    await expect(page.locator('#main > .item').last(), 'the newest item is the message').toContainText(text);
    await expect(page.locator('#main > .item').last()).toBeInViewport();
  });

test('#866 scrolling up grows the range, and the item you were reading stays where it was', async ({ page }) => {
  await open(page, LARGE, true);
  const before = (await counted(page)).items;
  // Bring an item near the top of what’s mounted into view, and note where it is in that same task, before the frame
  // in which the range grows above it.
  const reading = page.locator('#main > .item').nth(5);
  const key = await reading.getAttribute('data-key');
  const y = await reading.evaluate((n) => {
    n.scrollIntoView({ block: 'center' });
    return n.getBoundingClientRect().top;
  });
  await expect.poll(async () => (await counted(page)).items, { message: 'the range grew up' }).toBeGreaterThan(before);
  await settled(page);
  const after = await page.locator(`#main > .item[data-key="${key}"]`).evaluate((n) => n.getBoundingClientRect().top);
  expect(Math.abs(after - y), `the item was at ${y} px and is at ${after} px`).toBeLessThan(1);
});
