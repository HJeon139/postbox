// #168: a message has an address, its thread’s with m=<itemId>. Opened cold, in the main transcript or in a thread, it
// lands on the message: in view, focused and outlined. Copy link under a message gives it, by keyboard too. Going to
// what an agent needs puts the address on the history, so Back returns. One that names no message in the thread opens
// the thread and says so.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
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

/** A room of 60 messages with @researcher, the first far above the end. */
function longRoom(title) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const items = [];
  for (let i = 0; i < 60; i++)
    items.push(
      i % 2
        ? arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: `Reply ${i}: ${'what it found. '.repeat(12)}`, status: 'done' })
        : arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}: carry on.` }),
    );
  return { t, se, items };
}

/** Whether the message is drawn in view, and focus is in it. */
const landed = (page, id) =>
  page.evaluate((key) => {
    const node = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!node) return 'not drawn';
    const r = node.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return 'not in view';
    return node.contains(document.activeElement) ? 'landed' : 'not focused';
  }, id);

test('#168 an m= address opened cold lands on the message in the main transcript', async ({ page }) => {
  const { t, items } = longRoom('Address, main');
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
  const { t, se, items } = longRoom('Address, thread');
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
  const { t, items } = longRoom('Address, copy');
  const target = items.at(-2);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const copy = page.locator(`[data-key="${target.id}"]`).getByRole('button', { name: 'Copy link', exact: true });
  // Its name follows its text, which says Copied once it has: kept by a mark of its own here.
  await copy.evaluate((b) => b.setAttribute('data-test', 'copy'));
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-test="copy"]')).toHaveText('Copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${app.origin}/#/t/${t.id}?m=${target.id}`);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.goto(link);
  await expect.poll(() => landed(page, target.id), { message: 'the copied address lands on it' }).toBe('landed');
});

test('#168 going to what an agent needs puts its address on the history, and Back returns', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom('Address, needs');
  const ask = items[5];
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: 'Pick one' } });
  const elsewhere = longRoom('Address, elsewhere').t;
  await page.goto(`${app.origin}/#/t/${elsewhere.id}`);
  await synced(page, app);
  await page.keyboard.press('Control+j');
  await expect(page).toHaveURL(new RegExp(`#/t/${t.id}\\?m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
  await page.goBack();
  await expect(page, 'Back returns to where you were').toHaveURL(new RegExp(`#/t/${elsewhere.id}$`));
});

test('#168 an address to a message the thread doesn’t have opens the thread and says so', async ({ page }) => {
  const { t } = longRoom('Address, missing');
  // The page asks for the range around the message, and the server, which has none, answers 404.
  allowPageError(page, /status of 404/);
  await page.goto(`${app.origin}/#/t/${t.id}?m=it_nothere`);
  await synced(page, app);
  await expect(page.locator('.transcript')).toHaveAttribute('data-thread', t.id);
  await expect(page.getByText('That message isn’t here')).toBeVisible();
});

test('#168 an address to a message in the conversation lands there, though a thread was left open beside it', async ({ page }) => {
  const { t, se, items } = longRoom('Address, remembered thread');
  const topic = app.rt.startTopic(t.id, items.at(-1).id).threadId;
  arrange.post(app.rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'In the thread.', status: 'done' });
  // The thread open beside the conversation, so the page remembers it for this conversation.
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}`);
  await synced(page, app);
  await expect(page.locator('.sidepanel')).toBeVisible();
  // Away to another conversation: coming back, the page opens the thread it remembers, unless the address names a message.
  const away = longRoom('Address, away').t;
  await page.goto(`${app.origin}/#/t/${away.id}`);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}?m=${items[3].id}`);
  await expect(page, 'the address stays the message’s, with no thread added').toHaveURL(new RegExp(`#/t/${t.id}\\?m=${items[3].id}$`));
  await expect.poll(() => landed(page, items[3].id), { message: 'in the conversation, in view and focused' }).toBe('landed');
});

test('#168 going to an ask in the conversation on screen keeps Work open, and adds the ask’s address', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom('Address, Work open');
  const ask = items[5];
  arrange.setSession(rt, se.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: 'Pick one' } });
  await page.goto(`${app.origin}/#/t/${t.id}?work`);
  await synced(page, app);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect(page, 'Work stays, with the ask’s address').toHaveURL(new RegExp(`#/t/${t.id}\\?work&m=${ask.id}$`));
  await expect.poll(() => landed(page, ask.id), { message: 'on the ask' }).toBe('landed');
});

test('#168 Back to a message’s address after opening Work doesn’t pull the view back to the message', async ({ page }) => {
  const { t, items } = longRoom('Address, Back');
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
  await expect(page).toHaveURL(new RegExp(`\\?m=${items[3].id}$`));
  // Going to a message waits for it to be loaded and drawn: a second is longer than that takes here.
  const until = Date.now() + 1000;
  while (Date.now() < until) expect(await landed(page, items[3].id), 'still where you read').toBe('not in view');
});

test('#168 a thread closed by going to a message in its conversation isn’t opened again on coming back', async ({ page }) => {
  const { t, se, items } = longRoom('Address, thread closed');
  const topic = app.rt.startTopic(t.id, items.at(-1).id).threadId;
  arrange.post(app.rt, topic, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: 'In the thread.', status: 'done' });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${topic}`);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}?m=${items[3].id}`);
  await expect.poll(() => landed(page, items[3].id)).toBe('landed');
  const away = longRoom('Address, away again').t;
  await page.goto(`${app.origin}/#/t/${away.id}`);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page, 'the conversation alone, with no thread opened again').toHaveURL(new RegExp(`#/t/${t.id}$`));
});

test('#168 going to the same ask again after opening Work goes to it again', async ({ page }) => {
  const { rt } = app;
  const { t, se, items } = longRoom('Address, again');
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
  const { t, se, items } = longRoom('Address, ask in a thread');
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
