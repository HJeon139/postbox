// The view, published on the transcript (#531, B1b-a; designs/508/b1-view-state.md): data-view-mode is following or
// reading, and while reading, data-view-anchor and data-view-offset are the anchor's key and how far down the view it
// starts. V1: after every way the view can change, they say what the page shows. Following means at the end; reading
// means the named item starts that far down the view, within 1 px.
// Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { holds, LONG, open as openIn, read, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-read');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const room = (/** @type {string} */ title) => roomIn(app, title);
const open = (/** @type {any} */ page, /** @type {any} */ t, width = 1280) => openIn(app, page, t, width);

for (const width of [1280, 375]) {
  test(`V1 at ${width} px: mount, a wheel up, a reply growing below, End`, async ({ page }) => {
    const { t, say } = room(`View read at ${width}`);
    await open(page, t, width);
    expect((await holds(page, t, 'mounted')).mode).toBe('following');
    await page.mouse.move(width / 2, 400);
    await page.mouse.wheel(0, -1200);
    await settled(page);
    const up = await holds(page, t, 'after a wheel up');
    expect(up.mode).toBe('reading');
    const reply = say(`${LONG(31)}\n\n${LONG(32)}\n\n${LONG(33)}`);
    // With the events late (CI's lag pass), settled() can pass before the reply lands, which then lands during End.
    await expect(page.locator(`[data-key="${reply.id}"]`), 'the reply below is on the page').toBeAttached();
    await settled(page);
    const grown = await holds(page, t, 'after a reply below');
    expect(grown.anchor, 'the anchor stays while a reply lands below').toBe(up.anchor);
    await page.keyboard.press('End');
    await settled(page);
    expect((await holds(page, t, 'after End')).mode).toBe('following');
  });
}

test('V1: the jump pill and a resize', async ({ page }) => {
  const { t, say } = room('View read: pill and resize');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  say(LONG(40));
  await settled(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await settled(page);
  expect((await holds(page, t, 'after a resize while reading')).mode).toBe('reading');
  await page.locator('.jump').click();
  await settled(page);
  expect((await holds(page, t, 'after the jump pill')).mode).toBe('following');
});

test('V1: an anchor that moves to the end leaves its stub as the anchor', async ({ page }) => {
  const { t } = room('View read: a moved anchor');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  const before = await holds(page, t, 'reading');
  app.rt.bringForward(t.id, before.anchor, { what: 'block', title: 'Moved' });
  const stubId = app.store.state.items[t.id].find((it) => it.kind === 'moved' && it.itemId === before.anchor)?.id;
  await expect(page.locator(`[data-key="${stubId}"]`), 'the stub is drawn, with the events late too').toBeAttached();
  await settled(page);
  const after = await holds(page, t, 'after the anchor moved');
  expect(after.mode).toBe('reading');
  expect(after.anchor, 'the stub took the anchor').not.toBe(before.anchor);
  const stub = app.store.state.items[t.id].find((it) => it.id === after.anchor);
  expect(stub?.kind, 'the anchor is the moved item’s stub').toBe('moved');
});

// Each publish point, read in the same task as the change, before any scroll event could publish it instead.

test('V1 in the same task: an anchor moved to the end, and a reply in the frame you scroll up in (#341)', async ({ page }) => {
  const { t } = room('View read: same task');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  const before = await holds(page, t, 'reading');
  const got = await page.evaluate(
    async ({ threadId, anchor }) => {
      const { client } = await import('/app/js/client.mjs');
      const { apply } = await import('/shared/state.mjs');
      const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
      const now = Date.now();
      const send = (type, data) => {
        apply(client.state, type, data);
        client.emit({ type, data });
      };
      // The anchor moves to the end: its stub takes the place, at once.
      const stub = { id: 'it_stub_v1', kind: 'moved', at: now, itemId: anchor, what: 'block', title: 'Moved' };
      send('item.move', { threadId, id: anchor, stub, patch: { at: now, movedAt: now } });
      return { moved: el.dataset.viewAnchor };
    },
    { threadId: t.id, anchor: before.anchor },
  );
  expect(got.moved, 'the stub is the anchor in the same task').toBe('it_stub_v1');
  await settled(page);
  await page.keyboard.press('End');
  await settled(page);
  expect((await read(page, t)).mode).toBe('following');
  const inFrame = await page.evaluate(async (threadId) => {
    const { client } = await import('/app/js/client.mjs');
    const { apply } = await import('/shared/state.mjs');
    const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
    const item = {
      id: 'it_inframe_v1',
      kind: 'agent',
      handle: 'researcher',
      text: 'A reply in the same frame as the scroll up.',
      status: 'done',
      at: Date.now(),
    };
    scrollBy(0, -240);
    apply(client.state, 'item.add', { threadId, item });
    client.emit({ type: 'item.add', data: { threadId, item } });
    return el.dataset.viewMode;
  }, t.id);
  expect(inFrame, 'a reply in the frame you scrolled up in reads as reading at once').toBe('reading');
});

test('V1 in the same task: Jump to latest says following at once', async ({ page }) => {
  const { t, say } = room('View read: jump in the same task');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  say(LONG(50));
  await expect(page.locator('.jump')).toBeVisible();
  // The click runs in the page, which tests/AGENTS.md otherwise rules out (#307), so the attribute is read in the same
  // task as the click, before any scroll event could publish it instead.
  const mode = await page.evaluate((threadId) => {
    /** @type {HTMLElement} */ (document.querySelector('.jump button')).click();
    return /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`)).dataset.viewMode;
  }, t.id);
  expect(mode).toBe('following');
});

test('V1: a transcript says what it is from the moment it’s on the page', async ({ page }) => {
  const { t } = room('View read: mount');
  await page.addInitScript(() => {
    /** @type {any} */ (window).__firstMode = undefined;
    new MutationObserver((_, obs) => {
      const el = /** @type {HTMLElement | null} */ (document.querySelector('#main.transcript'));
      if (!el) return;
      /** @type {any} */ (window).__firstMode = el.dataset.viewMode ?? null;
      obs.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await open(page, t);
  expect(await page.evaluate(() => /** @type {any} */ (window).__firstMode)).toBe('following');
});

test.describe('at 2× pixels', () => {
  test.use({ deviceScaleFactor: 2 });
  test('V1: the offset is published to 0.1 px, so rounding never adds to the 1 px the check allows', async ({ page }) => {
    const { t } = room('View read: offset to 0.1 px');
    await open(page, t);
    await page.evaluate(() => scrollBy(0, -1200.5));
    await settled(page);
    const v = await holds(page, t, 'reading at a half pixel');
    expect(Math.abs(/** @type {number} */ (v.actual) - Number(v.offset)), 'within 0.1 px').toBeLessThanOrEqual(0.1);
    expect(Number(v.offset) % 1, 'the scroll left the anchor on a half pixel').not.toBe(0);
  });
});

test('V1: a redraw from new state that no longer has the anchor takes the anchor again where the view is', async ({ page }) => {
  const { t } = room('View read: anchor gone on a load');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  const before = await holds(page, t, 'reading');
  const after = await page.evaluate(
    async ({ threadId, anchor }) => {
      const { client } = await import('/app/js/client.mjs');
      const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
      client.state.items[threadId] = client.state.items[threadId].filter((it) => it.id !== anchor);
      client.emit({ type: 'load' });
      const now = el.dataset.viewAnchor;
      return { now, present: !!el.querySelector(`:scope > [data-key="${CSS.escape(String(now))}"]`) };
    },
    { threadId: t.id, anchor: before.anchor },
  );
  expect(after.now, 'a new anchor').not.toBe(before.anchor);
  expect(after.present, 'the published anchor is on the page').toBe(true);
});

test('V1 in the side panel: its own transcript publishes too', async ({ page }) => {
  const { t } = room('View read: panel');
  const { rt } = app;
  const side = rt.createThread({ projectId: t.projectId, title: 'A topic', kind: 'side', parentId: t.id, personaIds: [rt.personaByHandle('researcher').id] });
  const [se] = rt.sessionsIn(side.id);
  for (let i = 1; i <= 20; i++)
    rt.addItem(side.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: LONG(i), status: 'done' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}/side/${side.id}`);
  await synced(page, app);
  const panel = page.locator(`.sidepanel .transcript[data-thread="${side.id}"]`);
  await expect(panel).toBeAttached();
  await settled(page);
  await expect(panel).toHaveAttribute('data-view-mode', 'following');
  const box = await page.locator('.sidepanel .sp-body').boundingBox();
  await page.mouse.move(/** @type {any} */ (box).x + 50, /** @type {any} */ (box).y + 100);
  await page.mouse.wheel(0, -800);
  await settled(page);
  await expect(panel).toHaveAttribute('data-view-mode', 'reading');
  const v = await page.evaluate((id) => {
    const el = /** @type {HTMLElement} */ (document.querySelector(`.sidepanel .transcript[data-thread="${id}"]`));
    const n = el.querySelector(`:scope > [data-key="${CSS.escape(String(el.dataset.viewAnchor))}"]`);
    const top = /** @type {Element} */ (el.closest('.sp-body')).getBoundingClientRect().top;
    return { offset: Number(el.dataset.viewOffset), actual: n ? n.getBoundingClientRect().top - top : null };
  }, side.id);
  expect(v.actual, 'the panel’s anchor is on the page').not.toBeNull();
  expect(Math.abs(/** @type {number} */ (v.actual) - v.offset), 'it starts where it says, in the panel’s box').toBeLessThanOrEqual(1);
});
