// Each row of an agent’s queue says what is waiting (#1456): your answer to a card names the card, and your message
// says its words even when the page hasn’t loaded it, with nothing moving when they land, and a long one opens in full.
// With a scripted Claude Code agent held busy until the test ends.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox } from './postbox.mjs';
import { holdItemRequests, openQueue, QueueRooms } from './queue-rooms.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const rooms = new QueueRooms('Queue rows');

test.beforeAll(async () => {
  app = await startPostbox('queue-row-text');
  rooms.use(app);
});
test.afterAll(async () => {
  rooms.stop();
  await app?.stop();
});
failOnPageErrors(test);

test('your answer to a card waits in the queue named for the card', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  await rooms.answerCard(r);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText('Your answer to “Delete the video frames?”');
});

test('your answer to a card the page hasn’t loaded is named for the card it fetches', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  rooms.lines(r, 0);
  await rooms.answerCard(r);
  rooms.lines(r, 250);
  await rooms.reopen(page);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText('Your answer to “Delete the video frames?”');
});

test('your message the page hasn’t loaded still shows its words in the queue', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  rooms.lines(r, 0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} then check the second table` });
  rooms.lines(r, 250);
  await rooms.reopen(page);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} then check the second table`);
});

test('your message in a topic the page hasn’t opened shows its words in the queue', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  const root = arrange.post(app.rt, r.thread.id, { kind: 'user', text: 'Root line', attachments: [], to: [] });
  const { threadId } = app.rt.startTopic(r.thread.id, root.id);
  app.rt.sendMessage(threadId, { text: `@${r.worker.handle} in the topic, check the totals` });
  await rooms.reopen(page);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} in the topic, check the totals`);
});

test('a fetched message’s words move nothing when they land, and its edit shows in place of them', async ({ page }) => {
  const r = await rooms.busyRoom(page);
  rooms.lines(r, 0);
  const long = `@${r.worker.handle} ${'a long queued message that wraps across several lines in the dialog '.repeat(6).trim()}`;
  app.rt.sendMessage(r.thread.id, { text: long });
  rooms.lines(r, 250);
  await rooms.reopen(page);
  const held = await holdItemRequests(page);
  const dialog = await openQueue(page, r);
  const text = dialog.locator('.agent-queue-text');
  const send = dialog.getByRole('button', { name: /^Send now/ });
  const edit = dialog.getByRole('button', { name: /^Edit/ });
  await expect(text).toHaveText('Your message.');
  await expect(edit, 'Edit waits for the words, so Save can’t put the placeholder in their place').toBeDisabled();
  await settled(page);
  const before = await send.boundingBox();
  held.release();
  await expect(text).toHaveText(long);
  await expect(text).toHaveAttribute('title', long);
  await settled(page);
  expect(await send.boundingBox(), 'Send now stays under the pointer').toEqual(before);
  await edit.click();
  await dialog.getByRole('textbox', { name: 'Edit the queued message' }).fill(`@${r.worker.handle} edited words`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(text, 'the edit, not the copy fetched before it').toHaveText(`@${r.worker.handle} edited words`);
});

test('an agent’s long queued message opens in full by click or Enter, not only in a tooltip', async ({ page }) => {
  const r = await rooms.busyRoom(page, ['critic']);
  const long = `${'Check the totals in every quarterly table against the ledger before you publish them. '.repeat(4).trim()}`;
  arrange.wake(app.rt, r.senders[0].id, r.worker.handle, long);
  arrange.wake(app.rt, r.senders[0].id, r.worker.handle, 'Short one');
  const dialog = await openQueue(page, r);
  const text = dialog.getByRole('button', { name: long, exact: true });
  await expect(text).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByText('Short one', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Short one', exact: true }), 'a text the clamp doesn’t cut is no control').toHaveCount(0);
  const cut = () => text.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(await cut()).toBe(true);
  await text.focus();
  await page.keyboard.press('Enter');
  await expect(text).toHaveAttribute('aria-expanded', 'true');
  expect(await cut(), 'the whole message shows').toBe(false);
  await text.click();
  await expect(text).toHaveAttribute('aria-expanded', 'false');
  expect(await cut()).toBe(true);
});
