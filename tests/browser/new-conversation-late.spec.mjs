// A new conversation opens when its event reaches the page after you’re sent to it (#926). New conversation,
// Attach a session and New agent in a new conversation each make one through the API, then go to it. The page holds
// conversations’ `thread` events back until the test lets them go (hold-threads.mjs), so the late case happens on
// every run; POSTBOX_STREAM_LAG makes it happen by itself, some of the time.

import { expect, test } from '@playwright/test';
import { heldCount, holdThreads, release } from './hold-threads.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('new-conversation-late');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });

/** A room of its own, open in the page. */
async function openRoom(page, title) {
  const r = sideRoom(app, title);
  await page.goto(`${app.origin}/#/t/${r.room.id}`);
  await synced(page, app);
  return r;
}
/** Runs one of sheets.mjs’s openers in the page. @param {import('@playwright/test').Page} page */
const openSheet = (page, name, ...args) => page.evaluate(([name, args]) => import('/app/js/sheets.mjs').then((m) => m[name](...args)), [name, args]);
/** Waits until the page has heard a new conversation’s event and is holding it. */
const heard = (page) => expect.poll(() => heldCount(page), { message: 'the conversation’s event, held' }).toBeGreaterThan(0);
/**
 * Runs the page’s clock past the 200 ms the sheets waited before going to a new conversation on `main`, so the event
 * is still held when they go: without it, a quick release lands first and hides the race. The clock is the page’s own,
 * installed before it loads.
 * @param {import('@playwright/test').Page} page
 */
const pastTimers = (page) => page.clock.runFor(1000);
/** The id of the conversation a title names, on the server. */
const threadTitled = (title) => Object.values(app.store.state.threads).find((t) => t.title === title)?.id;
/** The page’s client listeners, but those that remove themselves once their element is gone. */
const listeners = (page) =>
  page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => [...client.listeners].filter((f) => !String(f).includes('.isConnected')).length));
/** Starts a conversation with @indexer from the New conversation sheet. */
async function startConversation(page, r, title) {
  await openSheet(page, 'openNewThread', r.room.projectId);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(title);
  // The sheet picks the first agent; leave @indexer alone in it.
  for (const on of await dialog.locator('.chips button[aria-pressed="true"]').all()) await on.click();
  await dialog.getByRole('button', { name: 'indexer', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start conversation' }).click();
  await expect(dialog).toBeHidden();
}
/** The conversation is open: its address, and its composer drawn. */
async function isOpen(page, threadId) {
  await expect(page).toHaveURL(new RegExp(`#/t/${threadId}$`));
  await expect(page.locator('#composer-input')).toBeVisible();
  await expect(page.locator(`.transcript[data-thread="${threadId}"]`)).toBeVisible();
}

test('New conversation opens it, when its event comes first', async ({ page }) => {
  const r = await openRoom(page, 'New first');
  await startConversation(page, r, 'Cataloging, first');
  await isOpen(page, threadTitled('Cataloging, first'));
});

for (const width of [375, 1280]) {
  test(`at ${width} px, New conversation opens it when its event arrives after the address`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await holdThreads(page, ['thread']);
    const r = await openRoom(page, `New late ${width}`);
    const before = await listeners(page);
    await startConversation(page, r, `Cataloging, late ${width}`);
    await heard(page);
    const id = threadTitled(`Cataloging, late ${width}`);
    await expect(page.locator(`.transcript[data-thread="${id}"]`), 'not drawn before its event').toHaveCount(0);
    await release(page);
    await isOpen(page, id);
    expect(await listeners(page), 'no listener left behind').toBeLessThanOrEqual(before);
  });
}

test('going to another room first stays there, and leaves no listener', async ({ page }) => {
  await holdThreads(page, ['thread']);
  const other = sideRoom(app, 'New elsewhere');
  const r = await openRoom(page, 'New left');
  await startConversation(page, r, 'Cataloging, left');
  await heard(page);
  // Closing the sheet left the address alone, so only the person’s move ends the wait.
  await expect(page).toHaveURL(new RegExp(`#/t/${r.room.id}$`));
  const before = await listeners(page);
  await page.evaluate((id) => {
    location.hash = `#/t/${id}`;
  }, other.room.id);
  await expect(page).toHaveURL(new RegExp(`#/t/${other.room.id}$`));
  await release(page);
  await expect.poll(() => listeners(page)).toBeLessThan(before);
  await expect(page).toHaveURL(new RegExp(`#/t/${other.room.id}$`));
});

test('a conversation that comes with the state loaded again, its own event still held, opens', async ({ page }) => {
  await holdThreads(page, ['thread']);
  const r = await openRoom(page, 'New resync');
  await startConversation(page, r, 'Cataloging, resync');
  await heard(page);
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  await isOpen(page, threadTitled('Cataloging, resync'));
});

test('two made while both are held each open in turn, and leave no listener', async ({ page }) => {
  await holdThreads(page, ['thread']);
  const r = await openRoom(page, 'New twice');
  const before = await listeners(page);
  await startConversation(page, r, 'Cataloging, one');
  await startConversation(page, r, 'Cataloging, two');
  await release(page);
  // If both events are held, release() hands them over in one loop, before any hashchange, so each wait goes to its
  // own conversation and the page ends on the second. If the second lands later (the stream lagged), the first one’s
  // move has ended its wait, and the page stays on the first. Either way it’s on one of the two, with no listener left.
  const one = threadTitled('Cataloging, one');
  const two = threadTitled('Cataloging, two');
  await expect(page).toHaveURL(new RegExp(`#/t/(${one}|${two})$`));
  await expect.poll(() => listeners(page)).toBe(before);
});

test('Attach a session opens its conversation when its event arrives late', async ({ page }) => {
  await holdThreads(page, ['thread']);
  await page.clock.install();
  const r = await openRoom(page, 'Attach late');
  const made = {};
  await page.route('**/api/claude-sessions', (route) =>
    route.fulfill({ json: { sessions: [{ id: 'cs-1', title: 'Shelf audit', at: Date.now(), cwd: app.root }] } }),
  );
  await page.route('**/api/claude-sessions/attach', (route) => {
    made.id = app.rt.createThread({ projectId: r.room.projectId, title: 'Shelf audit', personaIds: [r.indexer.personaId] }).id;
    return route.fulfill({ status: 201, json: { threadId: made.id } });
  });
  await openSheet(page, 'openAttachSession', r.room.projectId);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Shelf audit/ })
    .click();
  await heard(page);
  await pastTimers(page);
  await release(page);
  await isOpen(page, made.id);
});

test('New agent in a new conversation opens it when its event arrives late', async ({ page }) => {
  await holdThreads(page, ['thread']);
  await page.clock.install();
  const r = await openRoom(page, 'Agent late');
  await openSheet(page, 'openNewAgent', { projectId: r.room.projectId });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('cataloguer');
  await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(dialog).toBeHidden();
  await heard(page);
  await pastTimers(page);
  await release(page);
  await isOpen(page, threadTitled('With cataloguer'));
});
