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
  await expect(page.locator('[data-test="copy"]'), 'its icon a check, for those who see it').toHaveClass(/\bi-check\b/);
  await expect(page.locator('[data-test="copy"]'), 'back to Copy link after a moment').toHaveAttribute('aria-label', 'Copy link', { timeout: 4000 });
  await expect(page.locator('[data-test="copy"]')).toHaveClass(/\bi-copy\b/);
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

test('#168 in forced colors, a message’s Copy link icon still shows', async ({ page }) => {
  const { t, items } = longRoom(app, 'Address, forced colors');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const copy = page.locator(`[data-key="${items.at(-2).id}"]`).getByRole('button', { name: 'Copy link', exact: true });
  await copy.scrollIntoViewIfNeeded();
  const drawn = await copy.evaluate((b) => {
    const s = getComputedStyle(b, '::before');
    return { adjust: s.forcedColorAdjust, background: s.backgroundColor, color: getComputedStyle(b).color };
  });
  expect(drawn.adjust, 'the icon keeps its own color').toBe('none');
  expect(drawn.background, 'in the system’s button text color, not Canvas').toBe(drawn.color);
});

test('#168 a message’s reactions keep their pictures beside its actions’ drawn icons', async ({ page }) => {
  const { t, items } = longRoom(app, 'Address, reactions');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const reaction = page.locator(`[data-key="${items.at(-2).id}"] .react-btn`).first();
  await reaction.scrollIntoViewIfNeeded();
  const drawn = await reaction.evaluate((b) => {
    const s = getComputedStyle(b, '::before');
    return { image: s.backgroundImage, width: s.width };
  });
  expect(drawn.image, 'its picture, not a drawn icon').toMatch(/reaction-/);
  expect(drawn.width, 'at its own size, not an action icon’s 12 px').not.toBe('12px');
});

test('#168 in a side thread’s panel, the reactions and each action stay on one line', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, narrow row');
  const topic = app.rt.startTopic(t.id, items.at(-1).id).threadId;
  const reply = arrange.post(app.rt, topic, {
    kind: 'agent',
    sessionId: se.id,
    handle: 'researcher',
    text: 'In the thread, with a reply to send back.',
    status: 'done',
  });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}`);
  await synced(page, app);
  const row = page.locator(`.sidepanel [data-key="${reply.id}"] .msg-actions`);
  await expect(row.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
  const lines = await row.evaluate((r) => {
    const one = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
    const react = r.querySelector('.react-row');
    const send = [...r.children].find((c) => /Send to conversation|Sent to the conversation/.test(c.textContent ?? ''));
    return {
      react: one(react),
      button: one(react?.querySelector('.react-btn')),
      send: one(send),
      sendLine: send ? Math.round(parseFloat(getComputedStyle(send).lineHeight) || 0) : 0,
    };
  });
  expect(lines.react, 'the reactions on one line').toBeLessThanOrEqual(lines.button + 2);
  expect(lines.send, 'Send to conversation on one line').toBeLessThanOrEqual(30);
});

test('#168 in forced colors, the replies link’s icon takes the link color, and a sent note’s the text color', async ({ page }) => {
  const { t, se, items } = longRoom(app, 'Address, forced colors, link');
  const root = items.at(-1);
  const topic = app.rt.startTopic(t.id, root.id).threadId;
  const reply = arrange.post(app.rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'Sent back.', status: 'done' });
  app.rt.store.emit('item.patch', { threadId: topic, id: reply.id, patch: { sharedAt: Date.now() } });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}`);
  await synced(page, app);
  const colorOf = (loc) => loc.evaluate((el) => ({ glyph: getComputedStyle(el, '::before').backgroundColor, text: getComputedStyle(el).color }));
  const link = await colorOf(page.locator(`#main [data-key="${root.id}"] .msg-actions a.replies`));
  expect(link.glyph, 'the link’s icon in the link color').toBe(link.text);
  const sent = await colorOf(page.locator(`.sidepanel [data-key="${reply.id}"] .msg-actions span[data-glyph]`));
  expect(sent.glyph, 'the sent note’s icon in the text color').not.toBe('rgba(0, 0, 0, 0)');
});
