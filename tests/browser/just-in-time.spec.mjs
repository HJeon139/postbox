// The page loads what it draws, when it draws it (#1155): opening the page loads each conversation’s header, not its
// history; opening a conversation loads its latest items; scrolling past what’s loaded, a jump to an item (⌃J, an
// agent’s open asks), search and a resync each load the range they need. In a 10,000-item room, every path keeps the
// page’s elements within #1166’s budget and the items it holds to a few pages, where the page used to hold every item
// of every conversation.

import { expect, test } from '@playwright/test';
import { bigRoomItems, seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const COUNT = 10_000;
/** #1166’s budget for the page’s elements. */
const ELEMENTS = 5000;
/** The most items the page may hold of a conversation it shows: a few of its loads. */
const HELD = 1000;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
/** @type {any[]} */
let items = [];
let sessionId = '';
/** An asking block from long ago: 40 items in, far past what opening the room loads. */
const ASK = { id: 'it_jitask', kind: 'block', handle: 'researcher', turnId: null, valid: true, answered: false, at: 0 };
const BLOCK = { id: 'jit-ask', type: 'confirm', version: 1, fallback: 'Ship it?', statement: 'Ship the old plan?', confirmLabel: 'Ship' };
test.beforeAll(async () => {
  app = await startPostbox('just-in-time');
  const projectId = Object.values(app.rt.s.projects)[0].id;
  const t = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [app.rt.personaByHandle('researcher').id] });
  room = t.id;
  sessionId = app.rt.sessionsIn(room)[0].id;
  bigRoomItems({ count: COUNT }).items.forEach((item, i) => {
    if (i === 40) app.store.emit('item.add', { threadId: room, item: { ...ASK, sessionId, block: BLOCK, at: item.at } });
    app.store.emit('item.add', { threadId: room, item });
  });
  // A second room, so the page holds nothing of a conversation it doesn’t show.
  const other = app.rt.createThread({ projectId, title: 'Elsewhere', personaIds: [] }).id;
  seedBigRoom(app.store, other, { count: 2000, seed: 9 });
  items = app.store.items(room);
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** What the page costs now: its elements, and the items it holds, of every conversation. */
const cost = (page) =>
  page.evaluate(() =>
    import('/app/js/client.mjs').then(({ client }) => ({
      elements: document.getElementsByTagName('*').length,
      held: Object.values(client.state.items).reduce((n, list) => n + /** @type {any[]} */ (list).length, 0),
    })),
  );

/** Asserts the page is within its budgets. @param {any} page @param {string} where */
async function withinBudget(page, where) {
  const { elements, held } = await cost(page);
  expect(elements, `${where}: elements on the page`).toBeLessThanOrEqual(ELEMENTS);
  expect(held, `${where}: items the page holds`).toBeLessThanOrEqual(HELD);
}

const shown = (page, id) => page.locator(`#main > .item[data-key="${id}"]`);

async function open(page) {
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await expect(shown(page, items.at(-1).id)).toBeAttached({ timeout: 30_000 });
  await settled(page);
}

test('#1155 opening a 10,000-item room loads its latest items, not its history or another room’s', async ({ page }) => {
  await open(page);
  await withinBudget(page, 'opened');
  await expect(shown(page, items.at(-1).id)).toBeInViewport();
});

test('#1155 scrolling up past what’s loaded loads the range above, and keeps within budget', async ({ page }) => {
  await open(page);
  const firstLoaded = () => page.evaluate((id) => import('/app/js/client.mjs').then(({ client }) => client.state.items[id][0].id), room);
  const before = await firstLoaded();
  // Up to the top of what’s mounted, again and again, until a range from the server lands above.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        return firstLoaded();
      },
      { message: 'an older range loaded', timeout: 20_000 },
    )
    .not.toBe(before);
  const at = (/** @type {string | null} */ id) => items.findIndex((it) => it.id === id);
  const firstShown = await page.locator('#main > .item').first().getAttribute('data-key');
  expect(at(firstShown), 'an item older than the first load is on the page').toBeLessThan(at(before));
  await withinBudget(page, 'scrolled up');
});

test('#1155 ⌃J to an ask far up the room loads the range around it and jumps there', async ({ page }) => {
  app.rt.updateSession(sessionId, { state: 'needs', needs: { kind: 'block', itemId: ASK.id, text: 'Ship the old plan?' } });
  try {
    await open(page);
    await expect(shown(page, ASK.id), 'not loaded at first').toHaveCount(0);
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    await page.keyboard.press('Control+j');
    await expect(shown(page, ASK.id)).toBeInViewport({ timeout: 10_000 });
    await withinBudget(page, 'after ⌃J');
  } finally {
    app.rt.updateSession(sessionId, { state: 'idle', needs: null });
  }
});

test('#1155 an agent’s open-asks link to an old block loads the range around it and jumps there', async ({ page }) => {
  await open(page);
  await expect(shown(page, ASK.id), 'not loaded at first').toHaveCount(0);
  await page.locator(`[data-open-asks="${sessionId}"]:visible`).first().click();
  await expect(shown(page, ASK.id)).toBeInViewport({ timeout: 10_000 });
  await withinBudget(page, 'after the link');
});

test('#1155 search finds an item the page hasn’t loaded, and its hit loads the range around it', async ({ page }) => {
  await open(page);
  const target = items.find((it) => /zephyrine/.test(it.text));
  // The top bar's one search, Jump to… (#1233): the open conversation's messages come from the server.
  await page.getByRole('button', { name: /Jump to/ }).click();
  await page.locator('.dialog.palette').getByRole('combobox').fill('zephyrine');
  const hit = page.locator('.dialog.palette [data-item]').first();
  await expect(hit).toBeVisible();
  const id = await hit.getAttribute('data-item');
  expect(target, 'the room has a first-day item').toBeTruthy();
  expect(
    items.findIndex((it) => it.id === id),
    'a hit far up the room',
  ).toBeLessThan(COUNT - 1000);
  await hit.click();
  await expect(shown(page, /** @type {string} */ (id))).toBeInViewport({ timeout: 10_000 });
  await withinBudget(page, 'after search');
});

test('#1155 a resync loads the headers and the open range again, never the whole history', async ({ page }) => {
  await open(page);
  // A real resync: the stream reconnects naming another history's epoch, and the server tells the page to load the
  // state again, which closes the stream first, loads, and connects again (client.mjs, resync).
  let rewritten = false;
  await page.route('**/api/stream*', (route) => {
    if (rewritten) return route.continue();
    rewritten = true;
    const url = new URL(route.request().url());
    url.searchParams.set('epoch', 'ep_another_history');
    return route.continue({ url: url.href });
  });
  let loads = 0;
  page.on('request', (r) => r.url().includes('/api/state') && loads++);
  await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect()));
  await expect.poll(() => loads, 'told to resync, the page loads the state again').toBe(1);
  await synced(page, app);
  await expect(shown(page, items.at(-1).id)).toBeAttached();
  await withinBudget(page, 'after a resync');
});
