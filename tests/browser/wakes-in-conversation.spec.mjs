// Agents talk in the conversation (#372): an agent's @-mention, or its wake_agent message, wakes another there, both
// messages show in the main transcript, and no side thread or side-thread line appears; the reply goes back to the
// waker only if it @-mentions it. A side thread from before #372 opens read-only: a note in place of its composer.
// Each test has a room of its own (tests/browser/side-threads.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend, sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('wakes-in-conversation');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const rooms = [];
test.afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
});
function room(title) {
  const r = sideRoom(app, title);
  rooms.push(r);
  return r;
}

async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}
/** A message in the conversation's transcript, by its words. */
const said = (page, text) => page.locator('#main .item', { hasText: text });

test('an agent’s @-mention wakes another in the conversation: both messages show there, with no side thread, and no reply goes back', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Mentions');
  held.scripts.set(r.researcher.id, (ctx) => ctx.text('@indexer please index the 1908 edition.'));
  held.scripts.set(r.indexer.id, (ctx) => ctx.text('Indexed the 1908 edition: two chapters fewer.'));
  await open(page, `#/t/${r.room.id}`);
  const before = held.turns.length;
  rt.sendMessage(r.room.id, { text: '@researcher which edition do we index?' });
  await expect.poll(() => held.turns.slice(before).map((t) => t.sessionId), { message: 'both turns' }).toEqual([r.researcher.id, r.indexer.id]);
  await r.idle();
  await test.step('both messages are in the main transcript', async () => {
    await expect(said(page, '@indexer please index the 1908 edition.')).toBeVisible();
    await expect(said(page, 'Indexed the 1908 edition: two chapters fewer.')).toBeVisible();
  });
  await test.step('the woken turn ran in the conversation, and no side thread or line appeared', async () => {
    expect(held.turns.at(-1), '@indexer answered in the conversation').toMatchObject({ sessionId: r.indexer.id, thread: r.room.id });
    expect(r.sideOf(), 'no side thread').toBeUndefined();
    expect(store.items(r.room.id).filter((x) => x.kind === 'sidelink')).toEqual([]);
    await expect(page.locator('#main .pill', { hasText: 'asked' }), 'no side-thread line').toHaveCount(0);
  });
  // @indexer’s reply doesn’t @-mention @researcher, so @researcher isn’t woken again.
  expect(held.turns.slice(before).filter((t) => t.sessionId === r.researcher.id).length, 'no reply-back').toBe(1);
});

test('wake_agent posts its message in the conversation as the waker’s, and the woken agent answers there', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Tool');
  held.scripts.set(r.researcher.id, (ctx) => {
    ctx.tools.wake_agent({ handle: 'indexer', message: 'Index the 1999 edition too.' });
    ctx.text('Asked indexer for it.');
  });
  held.scripts.set(r.indexer.id, (ctx) => ctx.text('The 1999 edition is indexed.'));
  await open(page, `#/t/${r.room.id}`);
  rt.sendMessage(r.room.id, { text: '@researcher get the 1999 edition indexed' });
  await expect.poll(() => held.turns.some((t) => t.sessionId === r.indexer.id && t.thread === r.room.id), { message: '@indexer’s turn there' }).toBe(true);
  await r.idle();
  const wake = store.items(r.room.id).find((x) => x.kind === 'agent' && x.text === 'Index the 1999 edition too.');
  expect(wake, 'the wake is @researcher’s message in the conversation').toMatchObject({ handle: 'researcher', hop: 1 });
  await expect(said(page, 'Index the 1999 edition too.')).toBeVisible();
  await expect(said(page, 'The 1999 edition is indexed.')).toBeVisible();
  expect(r.sideOf(), 'no side thread').toBeUndefined();
});

test('a side thread from before #372 opens read-only: its lines, and a note where the composer was', async ({ page }) => {
  const { rt } = app;
  const r = room('Old side');
  const side = r.oldSide('Which editions differ?');
  await open(page, `#/t/${r.room.id}`);
  await page.locator('#main .pill', { hasText: '@indexer asked @researcher' }).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${r.room.id}/side/${side.id}$`));
  const panel = page.locator('.sidepanel');
  await expect(panel.getByText('Which editions differ?')).toBeVisible();
  await expect(panel.getByRole('note')).toHaveText('This side thread is read-only. Agents talk in the conversation now, where you can reply.');
  await expect(panel.getByRole('textbox'), 'no composer').toHaveCount(0);
  expect(() => rt.sendMessage(side.id, { text: '@researcher one more' }), 'the server takes no message there').toThrow(/read-only/);
});
