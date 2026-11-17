// Each row of an agent’s queue says what is waiting (#1456): your answer to a card names the card, and your message
// says its words even when the page hasn’t loaded it, fetched only for the rows in view, a few at a time, with nothing
// moving when they land. With a scripted Claude Code agent held busy until the test ends.
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const holds = new Set();
const releases = new Map();
let count = 0;

test.beforeAll(async () => {
  app = await startPostbox('queue-row-text');
  arrange.withAdapter(app.rt, {
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, _given, ctx) {
      if (holds.delete(session.id))
        await new Promise((resolve) => {
          releases.set(session.id, resolve);
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
      ctx.text('Done.');
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with one agent busy in a turn held open, and the page on it. */
async function busyRoom(page) {
  const n = ++count;
  const persona = app.rt.createPersona({ handle: `writer-${n}`, backend: 'claude-code' });
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Queue rows ${n}`, personaIds: [persona.id] });
  const [worker] = arrange.sessionsIn(app.rt, thread.id);
  holds.add(worker.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: `@${worker.handle} start the long work` });
  await expect.poll(() => releases.has(worker.id)).toBe(true);
  return { thread, worker };
}

/** Lines in the conversation: enough before and after an item that a page opened on it loads neither end with it (#1155). */
function lines(r, from, n = 250) {
  for (let i = from; i < from + n; i++) arrange.post(app.rt, r.thread.id, { kind: 'user', text: `Line ${i}`, attachments: [], to: [] });
}

/** Opens the page on the conversation again, so it holds only its first and latest items. */
async function reopen(page) {
  await page.reload();
  await synced(page, app);
}

/** The worker’s queue, opened from its row in the agents list. */
async function openQueue(page, r) {
  await page
    .locator('.agent-row')
    .filter({ hasText: r.worker.handle })
    .getByRole('button', { name: /queued for/ })
    .click();
  return page.getByRole('dialog', { name: new RegExp(`queued for ${r.worker.handle}`) });
}

/** Holds the queue’s item requests until the test lets them go, and counts each by the item it asks for. */
async function holdItemRequests(page) {
  const asked = new Map();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(/\/items\?around=/, async (route) => {
    const id = new URL(route.request().url()).searchParams.get('around');
    asked.set(id, (asked.get(id) ?? 0) + 1);
    await gate;
    await route.continue();
  });
  return { asked, release: () => release() };
}

/** Confirms a card the worker shows, so the answer waits in its queue. */
async function answerCard(r) {
  const confirm = {
    id: 'frames',
    type: 'confirm',
    version: 1,
    fallback: 'Delete the frames?',
    title: 'Delete the video frames?',
    statement: 'Delete the **23** untracked frames?',
    confirmLabel: 'Delete',
  };
  const said = await app.rt.toolsFor(r.worker.id).show_block({ block: confirm });
  expect(said.ok, said.message).toBe(true);
  const card = app.store.items(r.thread.id).find((x) => x.kind === 'block' && x.block.id === 'frames');
  app.rt.act(r.thread.id, card.id, 'confirm', {});
}

test('your answer to a card waits in the queue named for the card', async ({ page }) => {
  const r = await busyRoom(page);
  await answerCard(r);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText('Your answer to “Delete the video frames?”');
});

test('your answer to a card the page hasn’t loaded is named for the card it fetches', async ({ page }) => {
  const r = await busyRoom(page);
  lines(r, 0);
  await answerCard(r);
  lines(r, 250);
  await reopen(page);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText('Your answer to “Delete the video frames?”');
});

test('your message the page hasn’t loaded still shows its words in the queue', async ({ page }) => {
  const r = await busyRoom(page);
  lines(r, 0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} then check the second table` });
  lines(r, 250);
  await reopen(page);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} then check the second table`);
});

test('your message in a topic the page hasn’t opened shows its words in the queue', async ({ page }) => {
  const r = await busyRoom(page);
  const root = arrange.post(app.rt, r.thread.id, { kind: 'user', text: 'Root line', attachments: [], to: [] });
  const { threadId } = app.rt.startTopic(r.thread.id, root.id);
  app.rt.sendMessage(threadId, { text: `@${r.worker.handle} in the topic, check the totals` });
  await reopen(page);
  const dialog = await openQueue(page, r);
  await expect(dialog.locator('.agent-queue-text')).toHaveText(`@${r.worker.handle} in the topic, check the totals`);
});

test('a fetched message’s words move nothing when they land, and its edit shows in place of them', async ({ page }) => {
  const r = await busyRoom(page);
  lines(r, 0);
  const long = `@${r.worker.handle} ${'a long queued message that wraps across several lines in the dialog '.repeat(6).trim()}`;
  app.rt.sendMessage(r.thread.id, { text: long });
  lines(r, 250);
  await reopen(page);
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

test('the queue asks for a missing item once, however often it repaints while the item is on its way', async ({ page }) => {
  const r = await busyRoom(page);
  lines(r, 0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} asked for once` });
  lines(r, 250);
  await reopen(page);
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
  const r = await busyRoom(page);
  lines(r, 0);
  app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} the first words` });
  lines(r, 250);
  await reopen(page);
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

/** A conversation with this many of the person’s messages queued, none of which the page has loaded. */
async function longQueue(page, n) {
  const r = await busyRoom(page);
  lines(r, 0);
  for (let i = 0; i < n; i++) app.rt.sendMessage(r.thread.id, { text: `@${r.worker.handle} queued ${i}` });
  lines(r, 250);
  await reopen(page);
  return r;
}

test('a long queue fetches only the rows in view, a few at a time', async ({ page }) => {
  const r = await longQueue(page, 150);
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
  const r = await longQueue(page, 150);
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
  const r = await longQueue(page, 6);
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
  releases.get(r.worker.id)();
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
