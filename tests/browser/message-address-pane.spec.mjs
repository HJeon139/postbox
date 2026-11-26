// #168, with the right pane open: going to a message by its address keeps the conversation’s Work, its turn and the
// item open in it, drops a full view that would cover the message, goes to it again when asked again, and says when it
// isn’t there.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { landed, longRoom } from './message-address.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('message-address-pane');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 800 } });

test('#168 going to an ask in the conversation on screen keeps Work open, and adds the ask’s address', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom(app, 'Address, Work open');
  const ask = items[5];
  // Only this agent needs you, so ⌃J goes to it, not to one an earlier test left waiting.
  for (const other of Object.values(rt.store.state.sessions)) if (other.needs) arrange.setSession(rt, other.id, { state: 'idle', needs: null });
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: 'Pick one' } });
  await page.goto(`${app.origin}/#/t/${t.id}?work`);
  await synced(page, app);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect(page, 'Work stays, with the ask’s address').toHaveURL(new RegExp(`#/t/${t.id}\\?work&m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
});

test('#168 Back to a message’s address after opening Work doesn’t pull the view back to the message', async ({ page }) => {
  const { t, items } = longRoom(app, 'Address, Back');
  await page.goto(`${app.origin}/#/t/${t.id}?m=${items[3].id}`);
  await synced(page, app);
  await expect.poll(() => landed(page, items[3].id)).toBe('landed');
  // Read on, down to the end, then follow a link within the conversation, here to Work, and come back with Back.
  await page.keyboard.press('End');
  await expect.poll(() => landed(page, items[3].id), { message: 'read on past it' }).toBe('not in view');
  await page.evaluate((id) => {
    location.hash = `#/t/${id}?work`;
  }, t.id);
  await expect(page).toHaveURL(new RegExp(`#/t/${t.id}\\?work$`));
  await page.goBack();
  // Back to the message’s address, which opens Work again as it was left (messagePane, pane-route.mjs).
  await expect(page).toHaveURL(new RegExp(`\\?work&m=${items[3].id}$`));
  // Going to a message waits for it to be loaded and drawn: a second is longer than that takes here.
  const until = Date.now() + 1000;
  while (Date.now() < until) expect(await landed(page, items[3].id), 'still where you read').toBe('not in view');
});

test('#168 a thread closed by going to a message in its conversation isn’t opened again on coming back', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, thread closed');
  const topic = app.rt.startTopic(t.id, items.at(-1).id).threadId;
  arrange.post(app.rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'In the thread.', status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}`);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}?m=${items[3].id}`);
  await expect.poll(() => landed(page, items[3].id)).toBe('landed');
  const away = longRoom(app, 'Address, away again').t;
  await page.goto(`${app.origin}/#/t/${away.id}`);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page, 'the conversation alone, with no thread opened again').toHaveURL(new RegExp(`#/t/${t.id}$`));
});

test('#168 going to the same ask again after opening Work goes to it again', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom(app, 'Address, again');
  const ask = items[5];
  // Only this agent needs you, so ⌃J pressed again comes back to it rather than moving on to another.
  for (const other of Object.values(rt.store.state.sessions)) if (other.needs) arrange.setSession(rt, other.id, { state: 'idle', needs: null });
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: 'Pick one' } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
  await page.locator('#work-button').click();
  await expect(page).toHaveURL(/\?work$/);
  await page.keyboard.press('End');
  await expect.poll(() => landed(page, ask.id), { message: 'read on past it' }).toBe('not in view');
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect(page).toHaveURL(new RegExp(`\\?work&m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask again' }).toBe('landed');
});

test('#168 going to a message in a topic thread of the conversation on screen keeps Work open', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom(app, 'Address, ask in a thread');
  const topic = rt.startTopic(t.id, items.at(-1).id).threadId;
  const ask = arrange.post(rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'Which one?', status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}?work`);
  await synced(page, app);
  // As the open asks list goes to an ask in a thread (open-asks.mjs).
  await page.evaluate(
    async ([itemId, threadId]) => {
      const { goToItem } = await import('/app/js/needs-nav.mjs');
      await goToItem(itemId, threadId);
    },
    [ask.id, topic],
  );
  await expect(page, 'the thread opens beside the conversation, Work kept').toHaveURL(new RegExp(`#/t/${t.id}/side/${topic}\\?work&m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
});

test('#168 going to an ask with Work full screen shows the ask, with Work beside it', async ({ page }) => {
  const { t, items } = longRoom(app, 'Address, full Work');
  // With an item open in full-screen Work, which goes with it.
  await page.goto(`${app.origin}/#/t/${t.id}?work&full=work&at=as_open`);
  await synced(page, app);
  await page.evaluate(
    async ([itemId, threadId]) => {
      const { goToItem } = await import('/app/js/needs-nav.mjs');
      await goToItem(itemId, threadId);
    },
    [items[5].id, t.id],
  );
  await expect(page, 'Work kept, not full screen').toHaveURL(new RegExp(`#/t/${t.id}\\?work&m=${items[5].id}$`));
  await expect.poll(() => landed(page, items[5].id), { message: 'the ask, in view and focused' }).toBe('landed');
  const onTop = await page.evaluate((key) => {
    const r = document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect();
    return Boolean(r) && !!document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))?.closest(`[data-key="${CSS.escape(key)}"]`);
  }, items[5].id);
  expect(onTop, 'nothing covers it').toBe(true);
});

test('#168 going on purpose to a message the thread doesn’t have says so', async ({ page }) => {
  const { t } = longRoom(app, 'Address, gone on purpose');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  allowPageError(page, /status of 404/);
  await page.evaluate(async (threadId) => {
    const { goToItem } = await import('/app/js/needs-nav.mjs');
    await goToItem('it_deleted', threadId);
  }, t.id);
  await expect(page.getByText('That message isn’t here')).toBeVisible();
});

test('#168 going to an ask keeps the item open in Work beside the thread', async ({ page }) => {
  const { t, items } = longRoom(app, 'Address, item open in Work');
  await page.goto(`${app.origin}/#/t/${t.id}?work&at=as_open`);
  await synced(page, app);
  await page.evaluate(
    async ([itemId, threadId]) => {
      const { goToItem } = await import('/app/js/needs-nav.mjs');
      await goToItem(itemId, threadId);
    },
    [items[5].id, t.id],
  );
  await expect(page, 'Work and its open item kept').toHaveURL(new RegExp(`#/t/${t.id}\\?work&at=as_open&m=${items[5].id}$`));
});

test('#168 going to a message in the conversation with another thread full screen keeps Work’s open item', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, thread full screen');
  const topic = app.rt.startTopic(t.id, items.at(-1).id).threadId;
  arrange.post(app.rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'In the thread.', status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}?work&full=thread&at=as_open`);
  await synced(page, app);
  await page.evaluate(
    async ([itemId, threadId]) => {
      const { goToItem } = await import('/app/js/needs-nav.mjs');
      await goToItem(itemId, threadId);
    },
    [items[5].id, t.id],
  );
  await expect(page, 'the thread’s full view goes; Work and its item stay').toHaveURL(new RegExp(`#/t/${t.id}\\?work&at=as_open&m=${items[5].id}$`));
});

/** Only this session needs you, so ⌃J goes to its ask, not to one an earlier test left waiting. */
function onlyNeeds(rt, se, itemId) {
  for (const other of Object.values(rt.store.state.sessions)) if (other.needs) arrange.setSession(rt, other.id, { state: 'idle', needs: null });
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId, text: 'Pick one' } });
}

// Work is the conversation’s (#122): going to an ask in another conversation opens the Work left open there, as going
// back to that conversation does (designs/architecture/front-end.md, “The right pane”).
test('#168 going to an ask in another conversation opens the Work left open there', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, Work left open');
  const ask = items[5];
  onlyNeeds(app.rt, se, ask.id);
  await page.goto(`${app.origin}/#/t/${t.id}?work`);
  await synced(page, app);
  // Away, at a turn in its own Work: that turn is the other conversation’s, and doesn’t come along.
  const away = longRoom(app, 'Address, away from Work').t;
  await page.goto(`${app.origin}/#/t/${away.id}?work&turn=tu_elsewhere`);
  await synced(page, app);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect(page, 'Work as it was left, with the ask’s address').toHaveURL(new RegExp(`#/t/${t.id}\\?work&m=${ask.id}$`));
  await expect(page.locator('#work-button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
});

// In a window with no room for Work beside the conversation, Work would cover the ask (#197): going to it closes Work.
test('#168 in a window too narrow for Work beside the conversation, going to an ask shows the ask, not Work over it', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  const { t, se, items } = longRoom(app, 'Address, narrow Work');
  const ask = items[5];
  onlyNeeds(app.rt, se, ask.id);
  await page.goto(`${app.origin}/#/t/${t.id}?work`);
  await synced(page, app);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect(page, 'the ask’s address, without Work').toHaveURL(new RegExp(`#/t/${t.id}\\?m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
  const onTop = await page.evaluate((key) => {
    const r = document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect();
    return Boolean(r) && !!document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))?.closest(`[data-key="${CSS.escape(key)}"]`);
  }, ask.id);
  expect(onTop, 'nothing covers it').toBe(true);
});

// The same for an address that comes in with Work in it, as one ⌃J made in a wider window, opened or reloaded narrow.
test('#168 a message’s address with Work in it, opened in a window too narrow for Work, shows the message', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  const { t, items } = longRoom(app, 'Address, narrow with Work');
  await page.goto(`${app.origin}/#/t/${t.id}?work&m=${items[5].id}`);
  await synced(page, app);
  await expect(page, 'the message’s address, without Work').toHaveURL(new RegExp(`#/t/${t.id}\\?m=${items[5].id}$`));
  await expect.poll(() => landed(page, items[5].id), { message: 'on the message' }).toBe('landed');
});
