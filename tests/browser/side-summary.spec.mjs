// Summarize back in a side thread (#225), by keyboard: the panel’s Summarize back opens a menu of the thread’s two
// agents, the one that started it first; the agent picked writes the summary in the side thread, and it’s posted in
// the conversation as a summary from that thread. Its @-mention of the other agent wakes no one, and the wake limit
// doesn’t move. Asked while that agent is busy in the side thread, it waits behind that turn, and the button waits until
// the summary is posted. Since #372 a wake makes no side thread, so each test builds one from before it, in a room of
// its own (tests/browser/side-threads.mjs), and Summarize back still works on it.
// Moved from tools/checks/side-summary.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focused, startPostbox, synced } from './postbox.mjs';
import { heldBackend, sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('side-summary');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A room whose side thread @researcher answered @indexer in, open in the page at that thread. */
async function sideThread(page, title) {
  const r = sideRoom(app, title);
  // @indexer asked @researcher, which answered in the side thread, before #372.
  const side = r.oldSide('Which editions differ?');
  held.scripts.set(r.researcher.id, async (ctx) => ctx.text('The 1908 edition drops two chapters.'));
  r.runIn(side, r.researcher.id, 'Which editions differ?');
  await r.idle();
  await page.goto(`${app.origin}/#/t/${r.room.id}/side/${side.id}`);
  await synced(page, app);
  return { ...r, side, button: page.locator('.sidepanel .sp-head').getByRole('button', { name: 'Summarize back' }) };
}

test('#225 Summarize back in a side thread: pick who writes it, and the summary is posted in the conversation', async ({ page }) => {
  const { store } = app;
  const { room, side, indexer, idle, button } = await sideThread(page, 'Summarized');
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu [role=menuitem]')).toHaveText(['@indexer writes itstarted this thread', '@researcher writes it']);
  await expect.poll(() => focused(page), { message: 'focus on the first agent' }).toBe('menuitem: @indexer writes itstarted this thread');
  const hops = store.state.threads[room.id].hops;
  const before = held.turns.length;
  held.scripts.set(indexer.id, async (ctx) => ctx.text('@researcher found that the 1908 edition drops two chapters; nothing is open.'));
  await page.keyboard.press('Enter');
  // The request is a fetch from the page: its turn starts once the server has it.
  await expect.poll(() => held.turns.length, { message: 'the summary’s turn' }).toBeGreaterThan(before);
  await idle();
  const ran = held.turns.slice(before).map((x) => [x.sessionId === indexer.id ? 'indexer' : x.sessionId, x.thread === side.id]);
  expect(ran, 'one turn, @indexer’s, in the side thread').toEqual([['indexer', true]]);
  expect(store.state.threads[room.id].hops, 'the summary didn’t count against the wake limit').toBe(hops);
  await synced(page, app);
  await expect(page.locator('#main .shared-card', { hasText: '1908' })).toContainText(/^\s*Summary of the thread “@indexer ↔ @researcher” · @indexer/);
});

test('#225 Summarize back asked while its agent is busy in the side thread waits until the summary is posted', async ({ page }) => {
  const { store } = app;
  const { room, side, indexer, busy, idle, runIn, button } = await sideThread(page, 'Waits');
  // @indexer has a turn still running in the side thread, which holds, so the summary waits behind it.
  runIn(side, indexer.id, 'One more thing.', 'researcher');
  await expect.poll(() => busy(indexer.id), { message: '@indexer at work' }).toBe(true);
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu [role=menuitem]').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => !!store.state.threads[side.id].summaryPending, { message: 'the request on the server' }).toBe(true);
  // The turn it waited for ends, and the summary’s own turn starts: the button still waits, “Summary requested…”.
  const before = held.turns.length;
  held.release(indexer.id);
  await expect.poll(() => held.turns.length > before && /^Summarize/.test(held.turns.at(-1)?.text ?? ''), { message: 'the summary’s turn' }).toBe(true);
  await synced(page, app);
  const waiting = page.locator('.sidepanel .sp-head').getByRole('button', { name: 'Summary requested…', exact: true });
  await expect(waiting, 'it can’t be asked again while the summary is written').toBeDisabled();
  // Disabled, the button can’t keep focus. Before #372 the side thread’s composer took it; a side thread from before
  // #372 has none, so the panel’s Close button does, rather than the page.
  await expect(page.locator('.sidepanel .sp-head').getByRole('button', { name: 'Close side thread' })).toBeFocused();
  held.release(indexer.id);
  await idle();
  await synced(page, app);
  await expect(button, 'Summarize back once the summary is posted').toBeEnabled();
  const last = store.items(room.id).at(-1);
  expect(last.kind === 'shared' && last.summary && last.fromThreadId === side.id, 'the summary was posted in the conversation').toBe(true);
});
