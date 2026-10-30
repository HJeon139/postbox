// Apps and asking blocks follow the conversation (#49, #92): a new version, or a block that asks again, shows at the
// newest point, in view without scrolling, with a one-line stub where it was that leads to it, one live copy, and the
// transcript’s anchoring intact: what you were reading stays put, and if you were reading the item, its stub holds its
// place. ⌃J reaches a block that moved. Each test has a room of its own. Moved from tools/checks/follow.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('follow');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const LONG = (n) =>
  `Message ${n}. The ReAct loop alternates a thought, an action and an observation; the observation is the only outside evidence, so it keeps the plan grounded while the agent works through the search results one at a time.`;
const APP = (label) =>
  `<main style="padding:12px"><button class="btn" type="button" style="display:block;width:100%;height:200px">Explorer ${label}</button></main>`;

/** A room with an app from @critic, then `after` long messages under it. */
function room(title, appId, after = 14) {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title,
    personaIds: [rt.personaByHandle('researcher').id, rt.personaByHandle('critic').id],
  });
  const [researcher, critic] = rt.sessionsIn(t.id);
  const say = (se, text) => rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 4; i++) say(i % 2 ? critic : researcher, LONG(i));
  const tools = rt.toolsFor(critic.id);
  tools.show_app({ id: appId, title: 'Pair explorer', code: APP('v1'), permissions: [] });
  for (let i = 0; i < after; i++) say(i % 2 ? critic : researcher, LONG(100 + i));
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === appId);
  return { t, critic, tools, say, item };
}
async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('.transcript .item').first()).toBeVisible();
  await settled(page);
}

const gap = (page) => page.evaluate(() => Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight));
/** The message across the middle of an area of the page, and where it starts. */
const readingAt = (page, x, y) =>
  page.evaluate(
    ({ px, py }) => {
      const n = /** @type {HTMLElement | undefined} */ (document.elementFromPoint(px, py)?.closest('.item'));
      return n ? { key: n.dataset.key ?? '', top: Math.round(n.getBoundingClientRect().top) } : null;
    },
    { px: x, py: y },
  );
const reading = (page) => readingAt(page, 760, 450);
const topOf = (page, key) => page.locator(`[data-key="${key}"]`).evaluate((n) => Math.round(n.getBoundingClientRect().top));
/** Whether the whole of an item is inside the window, under the top bar and above the composer. */
const inView = (page, key) =>
  page.locator(`[data-key="${key}"]`).evaluate((n) => {
    const b = n.getBoundingClientRect();
    const c = document.querySelector('.composer')?.getBoundingClientRect().top ?? innerHeight;
    return b.top >= 0 && b.bottom <= c + 1;
  });
const lastKey = (page) => page.evaluate(() => /** @type {HTMLElement | undefined} */ ([...document.querySelectorAll('#main > .item')].at(-1))?.dataset.key);
/** Turns the mouse wheel at a point, and waits for the scroll and the transcript’s scroll event a frame after it. */
async function wheel(page, deltaY, x = 760, y = 400) {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, deltaY);
  await settled(page);
  await frames(page);
}
/** Waits for an item’s stub to be on the page and the item to be the newest, then for the page to hold still. */
async function stubOf(page, t, itemId) {
  await expect.poll(() => !!app.store.items(t.id).findLast((i) => i.kind === 'moved' && i.itemId === itemId), { message: 'the server made a stub' }).toBe(true);
  const stub = app.store.items(t.id).findLast((i) => i.kind === 'moved' && i.itemId === itemId).id;
  await expect(page.locator(`[data-key="${stub}"]`)).toBeAttached();
  await expect.poll(() => lastKey(page), { message: 'the moved item, newest' }).toBe(itemId);
  await settled(page);
  return stub;
}

test('#49 at the bottom: a new version shows at the newest point, in view, with a stub where it was and one copy', async ({ page }) => {
  const { t, tools, item } = room('Follows at the bottom', 'follow-bottom');
  await open(page, `#/t/${t.id}`);
  expect(await gap(page), 'opens at the bottom').toBeLessThanOrEqual(2);
  expect(await inView(page, item.id), 'the app starts out of view, above').toBe(false);
  app.rt.addItem(t.id, { kind: 'user', text: 'The graph overlaps. Can you fix it?' });
  tools.update_app({ id: 'follow-bottom', code: APP('v2'), summary: 'each group laid out on its own' });
  // v2’s check is recorded as passed, so its frame loads at once: this spec is about where the new version shows, and
  // the check itself is app-check’s to test. Waiting for a real one took more than 5 s on CI’s runner.
  app.rt.appCheck('follow-bottom', { version: 2, problems: [] });
  const stub = await stubOf(page, t, item.id);
  expect(await gap(page), 'the view stays at the bottom').toBeLessThanOrEqual(2);
  expect(await inView(page, item.id), 'the app is in view without scrolling').toBe(true);
  await expect(page.locator(`[data-key="${item.id}"]`), 'one copy on the page').toHaveCount(1);
  // Then exactly one frame runs it.
  await expect(page.locator(`[data-key="${item.id}"] iframe.app-iframe`), 'v2 loads').toBeAttached();
  await expect(page.locator('iframe.app-iframe'), 'one running frame').toHaveCount(1);
  await expect(page.locator(`[data-key="${stub}"]`)).toContainText(/Pair explorer · updated to v2 below/);
  await expect(page.locator(`[data-key="${stub}"]`)).toContainText('Go to it');
});

test('#49 scrolled up: an app leaving from above the view doesn’t move what you’re reading', async ({ page }) => {
  const { t, tools, item } = room('Follows, scrolled up', 'follow-up', 18);
  await open(page, `#/t/${t.id}`);
  await wheel(page, -500);
  const at = await reading(page);
  expect(at && at.key !== item.id, 'reading a message, not the app').toBe(true);
  expect(await topOf(page, item.id), 'the app is above it').toBeLessThan(at.top);
  tools.update_app({ id: 'follow-up', code: APP('v2') });
  await stubOf(page, t, item.id);
  expect(Math.abs((await topOf(page, at.key)) - at.top), 'the message you were reading stayed put').toBeLessThanOrEqual(1);
  expect(await gap(page), 'still scrolled up').toBeGreaterThan(200);
});

test('#49 reading the app: its stub holds the place, and Go to it leads to the moved app', async ({ page }) => {
  const { t, tools, item } = room('Follows while you read it', 'follow-read', 18);
  await open(page, `#/t/${t.id}`);
  await wheel(page, -300);
  await page.locator(`[data-key="${item.id}"]`).evaluate((n) => n.scrollIntoView({ block: 'center' }));
  // A turn of the wheel as small as it goes, so the transcript takes where you are as yours.
  await wheel(page, -1);
  expect((await reading(page))?.key, 'reading the app').toBe(item.id);
  const before = await topOf(page, item.id);
  tools.update_app({ id: 'follow-read', code: APP('v2') });
  const stub = await stubOf(page, t, item.id);
  expect(Math.abs((await topOf(page, stub)) - Math.max(0, before)), 'the stub is where the app was').toBeLessThanOrEqual(1);
  expect(await gap(page), 'the view didn’t jump to the bottom').toBeGreaterThan(200);
  await page.locator(`[data-key="${stub}"] button`).click();
  await expect
    .poll(() => page.evaluate((k) => !!document.activeElement?.closest(`[data-key="${k}"]`), item.id), { message: 'Go to it focuses the app' })
    .toBe(true);
  await settled(page);
  expect(await inView(page, item.id), 'and brings it into view').toBe(true);
});

/** A room whose topic thread has an app from its agent, under the root, and long messages after it. */
function topicWithApp() {
  const { rt, store } = app;
  const { t } = room('Follows in a panel', 'follow-panel-root', 2);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  // Its one session answers in the thread (#228), so the app shows there.
  const se = rt.sessionsIn(t.id)[0];
  const say = (n) => rt.addItem(threadId, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: LONG(n), status: 'done' });
  rt.toolsFor(se.id, /** @type {any} */ ({ threadId })).show_app({ id: 'follow-panel', title: 'Panel explorer', code: APP('v1'), permissions: [] });
  const item = store.items(threadId).find((i) => i.kind === 'block' && i.block.id === 'follow-panel');
  for (let i = 0; i < 16; i++) say(300 + i);
  return { t, threadId, se, say, item };
}

test('#49 in the side panel: an app in a topic thread moves there, and the panel keeps what you read still', async ({ page }) => {
  const { rt, store } = app;
  const { t, threadId, se, say, item } = topicWithApp();
  await open(page, `#/t/${t.id}/side/${threadId}`);
  const inPanel = page.locator(`.sidepanel .transcript[data-thread="${threadId}"]`);
  const body = page.locator('.sidepanel .sp-body');
  await expect(inPanel.locator('.item').first()).toBeVisible();
  const panelGap = () => body.evaluate((b) => Math.round(b.scrollHeight - b.scrollTop - b.clientHeight));
  const box = await body.boundingBox();
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Scrolled up in the panel, reading a message under the app.
  await wheel(page, -500, mid.x, mid.y);
  const at = await readingAt(page, mid.x, mid.y);
  expect(at && at.key !== item.id, 'reading a message in the panel').toBe(true);
  expect(await panelGap(), 'the panel is scrolled up').toBeGreaterThan(200);
  const stubs = () => store.items(threadId).filter((i) => i.kind === 'moved' && i.itemId === item.id);
  const lastInPanel = () =>
    inPanel.evaluate(
      (n) => /** @type {HTMLElement | undefined} */ ([...n.children].filter((c) => /** @type {HTMLElement} */ (c).dataset.key).at(-1))?.dataset.key,
    );
  rt.toolsFor(se.id).update_app({ id: 'follow-panel', code: APP('v2') });
  await expect.poll(() => stubs().length).toBe(1);
  await expect(inPanel.locator(`[data-key="${stubs()[0].id}"]`)).toBeAttached();
  await expect.poll(lastInPanel, { message: 'the app, newest in the panel' }).toBe(item.id);
  await settled(page);
  expect(Math.abs((await topOf(page, at.key)) - at.top), 'the message you were reading in the panel stayed put').toBeLessThanOrEqual(1);
  expect(await panelGap(), 'the panel is still scrolled up').toBeGreaterThan(200);
  // At the bottom of the panel, after more messages, the next version shows there, in view.
  for (let i = 0; i < 6; i++) say(400 + i);
  await synced(page, app);
  await body.evaluate((b) => {
    b.scrollTop = b.scrollHeight;
  });
  await settled(page);
  rt.toolsFor(se.id).update_app({ id: 'follow-panel', code: APP('v3') });
  await expect.poll(() => stubs().length).toBe(2);
  await expect(inPanel.locator(`[data-key="${stubs()[1].id}"]`)).toBeAttached();
  await expect.poll(lastInPanel, { message: 'the second move in the panel' }).toBe(item.id);
  await settled(page);
  expect(await panelGap(), 'the panel stays at its bottom').toBeLessThanOrEqual(2);
  const shown = await inPanel.locator(`[data-key="${item.id}"]`).evaluate((n, b) => {
    const r = n.getBoundingClientRect();
    const p = /** @type {Element} */ (document.querySelector(b)).getBoundingClientRect();
    return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
  }, '.sidepanel .sp-body');
  expect(shown, 'the app is in view in the panel').toBe(true);
  expect(store.items(t.id).filter((i) => i.kind === 'moved').length, 'the conversation itself has no stub').toBe(0);
});

test('#92 a confirm that asks again shows at the bottom with a stub, ⌃J goes to it, and answering it records one answer', async ({ page }) => {
  const { rt, store } = app;
  const { t, critic, say } = room('A block asks again', 'follow-block-app', 2);
  const tools = rt.toolsFor(critic.id);
  const block = (extra = {}) => ({
    id: 'frames',
    type: 'confirm',
    version: 1,
    fallback: 'Delete the frames?',
    statement: 'Delete the 23 video frames in app/media?',
    confirmLabel: 'Delete them',
    ...extra,
  });
  tools.show_block({ block: block() });
  const item = store.items(t.id).at(-1);
  rt.act(t.id, item.id, 'confirm', {}, 1);
  // The answer wakes @critic, a mock agent: let that turn end first, so its reply lands before the update.
  await expect.poll(() => rt.turns.has(critic.id) || rt.exiting.has(critic.id), { message: '@critic’s turn to end' }).toBe(false);
  rt.patchItem(t.id, item.id, { answer: { ...store.item(t.id, item.id).answer, read: true } });
  for (let i = 0; i < 14; i++) say(critic, LONG(200 + i));
  await open(page, `#/t/${t.id}`);
  expect(await inView(page, item.id), 'the answered confirm is out of view, above').toBe(false);
  tools.update_block({ block: block({ title: 'Video frames deleted', statement: 'Deleted. Anything else to clear?', confirmLabel: 'OK' }) });
  // Once updated, it’s the one agent that needs you, as #69 leaves it when a turn ends on a block that asks again. ⌃J
  // goes to the next agent that needs you, so none other does.
  for (const se of Object.values(store.state.sessions)) if (se.needs && se.id !== critic.id) rt.updateSession(se.id, { needs: null, state: 'idle' });
  rt.updateSession(critic.id, { state: 'needs', needs: { kind: 'block', itemId: item.id, text: 'Video frames deleted' } });
  const stub = await stubOf(page, t, item.id);
  expect(await gap(page), 'the view stays at the bottom').toBeLessThanOrEqual(2);
  expect(await inView(page, item.id), 'the confirm is in view without scrolling').toBe(true);
  await expect(page.locator(`[data-key="${stub}"]`)).toContainText(/Video frames deleted · asked again below/);
  // ⌃J goes to the moved block, from anywhere in the conversation, and focuses its button.
  await wheel(page, -2000);
  expect(await inView(page, item.id), 'scrolled away from it').toBe(false);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect
    .poll(() => page.evaluate((k) => !!document.activeElement?.closest(`[data-key="${k}"]`), item.id), { message: '⌃J focuses the moved confirm' })
    .toBe(true);
  await settled(page);
  expect(await inView(page, item.id), '⌃J brings it into view').toBe(true);
  await page.locator(`[data-key="${item.id}"]`).getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('.voice'), 'your answer’s line').toHaveCount(2);
  expect(store.item(t.id, item.id).answer?.revision, 'the answer is for the revision you saw').toBe(2);
  expect(store.items(t.id).filter((i) => i.kind === 'voice').length, 'one line for each answer').toBe(2);
});

test('#410 ⌃J brings a block into view when something grows between its scroll and the scroll’s event', async ({ page }) => {
  const { rt, store } = app;
  const { t, critic } = room('Grown under ⌃J', 'follow-grown-j', 14);
  rt.toolsFor(critic.id).show_block({
    block: { id: 'grown-ask', type: 'confirm', version: 1, fallback: 'Clear it?', statement: 'Clear the frames?', confirmLabel: 'Clear' },
  });
  const ask = store.items(t.id).at(-1);
  for (const se of Object.values(store.state.sessions)) if (se.needs && se.id !== critic.id) rt.updateSession(se.id, { needs: null, state: 'idle' });
  rt.updateSession(critic.id, { state: 'needs', needs: { kind: 'block', itemId: ask.id, text: 'Clear the frames?' } });
  await open(page, `#/t/${t.id}`);
  await wheel(page, -2000);
  expect(await inView(page, ask.id), 'scrolled away from the block').toBe(false);
  // The block grows in a task right after ⌃J’s scroll, before the scroll’s event, past the room the transcript holds
  // below it: in CI, the page grew by 20 px there, as an app’s check gave way to its frame.
  await page.evaluate((grows) => {
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (o) {
      Element.prototype.scrollIntoView = scroll;
      scroll.call(this, o);
      setTimeout(() => {
        /** @type {HTMLElement} */ (document.querySelector(`[data-key="${grows}"]`)).style.paddingBottom = '60px';
      });
    };
  }, ask.id);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect.poll(() => page.evaluate((k) => !!document.activeElement?.closest(`[data-key="${k}"]`), ask.id), { message: '⌃J focuses the block' }).toBe(true);
  await settled(page);
  expect(await inView(page, ask.id), '⌃J brings it into view').toBe(true);
});
