// An agent’s queue fetches the items it lacks only for the rows in view, a few at a time and once each, paints at most
// once a frame, and once closed asks for nothing and paints nothing (#1456). With a scripted Claude Code agent held busy
// until the test ends.
import { expect, test } from '@playwright/test';
import { RAISE_RESOURCE_BUFFER } from '../../tools/uat/diagram-probe.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { frameHold, holdItemRequests, openQueue, QueueRooms } from './queue-rooms.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const rooms = new QueueRooms('Queue fetch');

test.beforeAll(async () => {
  app = await startPostbox('queue-fetch');
  rooms.use(app);
});
test.afterAll(async () => {
  rooms.stop();
  await app?.stop();
});
failOnPageErrors(test);
// Requests are counted in resource timing, whose browser default of 250 entries the page’s own load nearly fills.
test.beforeEach(({ page }) => page.addInitScript({ content: RAISE_RESOURCE_BUFFER }));

test('the queue asks for a missing item once, however often it repaints while the item is on its way', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  rooms.lines(r, 0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} asked for once` });
  rooms.lines(r, 250);
  await rooms.reopen(page);
  const held = await holdItemRequests(page);
  const dialog = await openQueue(page, r);
  await expect.poll(() => held.asked.size).toBe(1);
  // Each change to the conversation repaints the open queue.
  for (let i = 1; i <= 5; i++) {
    arrange.setThread(app.rt, r.thread.id, { hops: i });
    await synced(page, app);
  }
  held.release();
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} asked for once`);
  expect([...held.asked.values()]).toEqual([1]);
});

test('a queue opened again shows a message as it is now, not as it was fetched before', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  rooms.lines(r, 0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} the first words` });
  rooms.lines(r, 250);
  await rooms.reopen(page);
  let dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} the first words`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const [entry] = arrange.waitingEntries(app.rt, r.worker.id).filter((e) => e.source === 'person');
  app.rt.editQueued(r.thread.id, entry.id, `@${r.worker.handle} the second words`);
  await synced(page, app);
  dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} the second words`);
});

test('a long queue fetches only the rows in view, a few at a time', async ({ page }) => {
  const r = await rooms.longQueue(page, 150);
  const held = await holdItemRequests(page);
  const dialog = await openQueue(page, r);
  const rows = dialog.locator('.agent-queue-text');
  await expect(rows).toHaveCount(150);
  await expect.poll(() => held.asked.size).toBe(4);
  // Rows scrolled into view while those four are on their way wait their turn.
  await rows.nth(80).scrollIntoViewIfNeeded();
  await settled(page);
  expect(held.asked.size, 'no more requests at once than the queue’s limit').toBe(4);
  held.release();
  await expect(rows.nth(80)).toHaveText(`@${r.worker.handle} queued 80`);
  await expect(rows.nth(149), 'a row never in view isn’t fetched').toHaveText('Your message.');
  expect(held.asked.size, 'only the rows that were in view').toBeLessThan(20);
});

test('a row scrolled out of view before its turn gives its place to the rows in view', async ({ page }) => {
  const r = await rooms.longQueue(page, 150);
  const held = await holdItemRequests(page);
  const dialog = await openQueue(page, r);
  const rows = dialog.locator('.agent-queue-text');
  await expect.poll(() => held.asked.size).toBe(4);
  // Rows 80 or so wait behind the four on their way, then scroll away before their turn.
  await rows.nth(80).scrollIntoViewIfNeeded();
  await settled(page);
  await rows.nth(140).scrollIntoViewIfNeeded();
  await settled(page);
  held.release();
  await expect(rows.nth(140)).toHaveText(`@${r.worker.handle} queued 140`);
  await settled(page);
  await expect(rows.nth(80), 'a row that left the view before its turn isn’t fetched').toHaveText('Your message.');
});

test('a queue closed while its items are on their way asks for no more, and moves no focus when they land', async ({ page }) => {
  const r = await rooms.longQueue(page, 6);
  const held = await holdItemRequests(page);
  const dialog = await openQueue(page, r);
  const rows = dialog.locator('.agent-queue-text');
  await expect.poll(() => held.asked.size).toBe(4);
  // The last rows come into view and wait behind the four on their way.
  await rows.nth(5).scrollIntoViewIfNeeded();
  await settled(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // The person goes on elsewhere, and the agent takes every queued message, so the queue is empty.
  const transcript = page.locator(`.transcript[data-thread="${r.thread.id}"]`);
  await transcript.focus();
  rooms.releases.get(r.worker.id)();
  await expect(
    page
      .locator('.agent-row')
      .filter({ hasText: r.worker.handle })
      .getByRole('button', { name: /queued for/ }),
  ).toBeHidden();
  held.release();
  // The replies land on the closed queue: a request after them would be one it made.
  const landed = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('around=')).length);
  await expect.poll(landed).toBe(4);
  await settled(page);
  await synced(page, app);
  expect(held.asked.size).toBe(4);
  await expect(transcript, 'a closed queue’s replies move no focus').toBeFocused();
});

test('a queue closed before its next paint paints nothing, so no focus moves', async ({ page }) => {
  const frames = await frameHold(page);
  const r = await rooms.busyRoom(page);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} one to remove` });
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} one to remove`);
  // The message leaves the queue, and the person closes it, before the frame that would paint it comes.
  await frames.hold();
  const [entry] = arrange.waitingEntries(app.rt, r.worker.id).filter((e) => e.source === 'person');
  app.rt.cancelQueued(r.thread.id, entry.id);
  await expect.poll(frames.waiting).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const transcript = page.locator(`.transcript[data-thread="${r.thread.id}"]`);
  await transcript.focus();
  await frames.release();
  await settled(page);
  await expect(transcript, 'a closed queue’s paint moves no focus').toBeFocused();
});

test('changes that land in one frame paint the queue once', async ({ page }) => {
  const frames = await frameHold(page);
  const r = await rooms.busyRoom(page);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} the first` });
  const dialog = await openQueue(page, r);
  const rows = dialog.locator('.agent-queue-text');
  await expect(rows).toHaveCount(1);
  await frames.hold();
  for (const n of ['second', 'third', 'fourth']) app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} the ${n}` });
  await synced(page, app);
  await expect(rows, 'nothing paints before the frame').toHaveCount(1);
  await frames.release();
  await expect(rows).toHaveCount(4);
});
