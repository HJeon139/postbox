// #168: a message has an address, its thread’s with m=<itemId>. Opened cold, in the main transcript or in a thread, it
// lands on the message: in view, focused and outlined. Copy link under a message gives it, by keyboard too. Going to
// what an agent needs puts the address on the history, so Back returns. One that names no message in the thread opens
// the thread and says so.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { landed, longRoom } from './message-address.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('message-address');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 800 } });

test('#168 an m= address opened cold lands on the message in the main transcript', async ({ page }) => {
  const { t, items } = longRoom(app, 'Address, main');
  const target = items[3];
  await page.goto(`${app.origin}/#/t/${t.id}?m=${target.id}`);
  await synced(page, app);
  await expect.poll(() => landed(page, target.id), { message: 'in view and focused' }).toBe('landed');
  // And again after a reload.
  await page.reload();
  await synced(page, app);
  await expect.poll(() => landed(page, target.id), { message: 'after a reload' }).toBe('landed');
});

test('#168 an m= address opened cold lands on the message in a topic thread', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, thread');
  const topic = app.rt.startTopic(t.id, items[1].id).threadId;
  const inTopic = [];
  for (let i = 0; i < 30; i++)
    inTopic.push(
      arrange.post(app.rt, topic, {
        kind: 'agent',
        sessionId: se.id,
        handle: 'researcher',
        text: `In the thread ${i}: ${'a finding. '.repeat(12)}`,
        status: 'done',
      }),
    );
  const target = inTopic[2];
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}?m=${target.id}`);
  await synced(page, app);
  await expect(page.locator(`.sidepanel [data-key="${target.id}"]`)).toBeAttached();
  await expect.poll(() => landed(page, target.id), { message: 'in the thread, in view and focused' }).toBe('landed');
});

test('#168 Copy link, by keyboard, copies the message’s address, and the address lands on it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { t, items } = longRoom(app, 'Address, copy');
  const target = items.at(-2);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // Copy link is the last of the message’s actions: Tab from Reply in thread reaches it.
  const message = page.locator(`[data-key="${target.id}"]`);
  await message.getByRole('button', { name: 'Reply in thread' }).focus();
  await page.keyboard.press('Tab');
  const copy = message.getByRole('button', { name: 'Copy link', exact: true });
  await expect(copy, 'reached by Tab from the message’s actions').toBeFocused();
  // Its name says what it did once pressed: kept by a mark of its own here.
  await copy.evaluate((b) => b.setAttribute('data-test', 'copy'));
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-test="copy"]')).toHaveAttribute('aria-label', 'Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${app.origin}/#/t/${t.id}?m=${target.id}`);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.goto(link);
  await expect.poll(() => landed(page, target.id), { message: 'the copied address lands on it' }).toBe('landed');
});

test('#168 going to what an agent needs puts its address on the history, and Back returns', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom(app, 'Address, needs');
  const ask = items[5];
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: 'Pick one' } });
  const elsewhere = longRoom(app, 'Address, elsewhere').t;
  await page.goto(`${app.origin}/#/t/${elsewhere.id}`);
  await synced(page, app);
  await page.keyboard.press('Control+j');
  await expect(page).toHaveURL(new RegExp(`#/t/${t.id}\\?m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
  await page.goBack();
  await expect(page, 'Back returns to where you were').toHaveURL(new RegExp(`#/t/${elsewhere.id}$`));
});

test('#168 an address to a message the thread doesn’t have opens the thread and says so', async ({ page }) => {
  const { t } = longRoom(app, 'Address, missing');
  // The page asks for the range around the message, and the server, which has none, answers 404.
  allowPageError(page, /status of 404/);
  await page.goto(`${app.origin}/#/t/${t.id}?m=it_nothere`);
  await synced(page, app);
  await expect(page.locator('.transcript')).toHaveAttribute('data-thread', t.id);
  await expect(page.getByText('That message isn’t here')).toBeVisible();
});

test('#168 an address to a message in the conversation lands there, though a thread was left open beside it', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, remembered thread');
  const topic = app.rt.startTopic(t.id, items.at(-1).id).threadId;
  arrange.post(app.rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'In the thread.', status: 'done' });
  // The thread open beside the conversation, so the page remembers it for this conversation.
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}`);
  await synced(page, app);
  await expect(page.locator('.sidepanel')).toBeVisible();
  // Away to another conversation: coming back, the page opens the thread it remembers, unless the address names a message.
  const away = longRoom(app, 'Address, away').t;
  await page.goto(`${app.origin}/#/t/${away.id}`);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}?m=${items[3].id}`);
  await expect(page, 'the address stays the message’s, with no thread added').toHaveURL(new RegExp(`#/t/${t.id}\\?m=${items[3].id}$`));
  await expect.poll(() => landed(page, items[3].id), { message: 'in the conversation, in view and focused' }).toBe('landed');
});
