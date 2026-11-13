// The transcript window far from the view (#866, critic’s integrator pass on #1075): a scroll that lands well past the
// range’s edges, a drag of the scrollbar, Home, End or Jump to latest, shows items at once (past what the page holds,
// once they’re loaded, #1155), not a blank spacer while the range walks over; a window torn down before its first frame
// leaves nothing listening; and a reply that streams in while you read higher up is still announced, though it isn’t
// mounted or loaded.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

const COUNT = 2000;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('window-far');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** A room of COUNT items, open at its end, with the window on as a long room opens by default. */
async function open(page) {
  const projectId = /** @type {any} */ (Object.values(app.rt.store.state.projects)[0]).id;
  const t = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [] });
  seedBigRoom(app.store, t.id, { count: COUNT });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
  // Keys go to the page, not the composer, so Home and End scroll it.
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  return t;
}

/** Jumps to an early item as Needs you does (needs-nav.mjs, focusItem), which moves the range there, away from the end. */
async function farUp(page, t) {
  const early = app.store.items(t.id)[10].id;
  expect(await page.evaluate((id) => import('/app/js/needs-nav.mjs').then((m) => m.focusItem(id)), early)).toBe(true);
  await settled(page);
  const last = app.store.items(t.id).at(-1).id;
  await expect(page.locator(`#main > .item[data-key="${last}"]`), 'the end is no longer mounted').toHaveCount(0);
}

/** Whether a mounted item lies across the middle of the view, give or take the gap between two items. */
const itemAtMiddle = (page) =>
  page.evaluate(() => {
    const mid = innerHeight / 2;
    return [...document.querySelectorAll('#main > .item')].some((n) => {
      const r = n.getBoundingClientRect();
      return r.top <= mid + 16 && r.bottom >= mid - 16;
    });
  });

/** After a scroll, two frames for the range to follow, then whether an item is in view where you landed. */
async function shownAfter(page, scroll) {
  await page.evaluate(scroll);
  await frames(page);
  await frames(page);
  return itemAtMiddle(page);
}

test('#866 a scroll to the middle of a long room shows items there within two frames, where it was dragged', async ({ page }) => {
  await open(page);
  const target = await page.evaluate(() => document.scrollingElement.scrollHeight / 2);
  expect(await shownAfter(page, () => scrollTo(0, document.scrollingElement.scrollHeight / 2)), 'an item across the middle of the view').toBe(true);
  await settled(page);
  // Where it was dragged, within 3%: the range moved to the item that was there, by where the spacer sat on the page,
  // not by heights estimated since (7% short here and a third short in critic’s probe, before 430191f9’s fix).
  const y = await page.evaluate(() => scrollY);
  expect(Math.abs(y - target), `the view at ${Math.round(y)}, dragged to ${Math.round(target)}`).toBeLessThan(target * 0.03);
});

test('#866 Home in a long room opened at its end shows its first items, and End its last', async ({ page }) => {
  const t = await open(page);
  // The page holds only the latest items it opened on (#1155): Home loads the first ones, then goes there.
  await page.keyboard.press('Home');
  const first = app.store.items(t.id)[0].id;
  await expect(page.locator(`#main > .item[data-key="${first}"]`), 'the first item, at the top').toBeInViewport();
  await page.keyboard.press('End');
  const last = app.store.items(t.id).at(-1).id;
  await expect(page.locator(`#main > .item[data-key="${last}"]`), 'the newest item, at the end').toBeInViewport();
});

test('#866 Jump to latest from far up a long room lands on the newest item', async ({ page }) => {
  const t = await open(page);
  await farUp(page, t);
  const it = arrange.post(app.rt, t.id, { kind: 'user', text: 'A message while you read far up.' });
  await synced(page, app);
  const jump = page.getByRole('button', { name: /Jump to latest/ });
  await expect(jump).toBeVisible();
  // Far up, the page holds an older range than the newest (#1155): the jump loads the latest, then goes to the end at
  // once, rather than scrolling smoothly over spacers the range then walks a view at a time.
  await jump.click();
  await expect(page.locator(`#main > .item[data-key="${it.id}"]`), 'the newest item').toBeInViewport({ timeout: 5000 });
});

test('#866 a resync twice in one task leaves no window listening to the scroll, and a scroll throws nothing', async ({ page }) => {
  await open(page);
  // Each load rebuilds the transcript’s window; the first is torn down before its first frame (thread.mjs, all()).
  await page.evaluate(() =>
    import('/app/js/client.mjs').then(({ client }) => {
      client.emit({ type: 'load' });
      client.emit({ type: 'load' });
    }),
  );
  await frames(page);
  await page.mouse.move(640, 400);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -2000);
    await frames(page);
  }
  await settled(page);
  await expect(page.locator('#main > .item').first()).toBeAttached();
});

test('#866 a reply streaming in while you read far up is announced, though the window hasn’t mounted it', async ({ page }) => {
  const t = await open(page);
  await farUp(page, t);
  // Every text the live region is given, since a later announcement replaces the one before (ui.mjs, say).
  await page.evaluate(() => {
    const live = /** @type {HTMLElement} */ (document.getElementById('live'));
    const said = /** @type {string[]} */ ([]);
    /** @type {any} */ (window).said = said;
    new MutationObserver(() => live.textContent && said.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
  });
  const it = arrange.post(app.rt, t.id, { kind: 'agent', handle: 'researcher', text: '', status: 'streaming' });
  for (const chunk of ['The build passed ', 'on both Node versions. ', 'Now the browser runs. ']) {
    app.store.emit('item.text', { threadId: t.id, id: it.id, text: chunk });
    await frames(page);
  }
  await expect(page.locator(`#main > .item[data-key="${it.id}"]`), 'not mounted, far below the view').toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).said.join(' | ')), { message: 'announced as it streams' })
    .toContain('The build passed on both Node versions.');
});

test('#866 an item kept for its focus stays in its place in the conversation when the range jumps past it', async ({ page }) => {
  const t = await open(page);
  const ids = app.store.items(t.id).map((it) => it.id);
  // Focus an item in the middle, then move the range above it and then below it without moving focus, so it’s kept
  // on the page as an island each time (window-live.mjs, mountFor).
  expect(await page.evaluate((id) => import('/app/js/needs-nav.mjs').then((m) => m.focusItem(id)), ids[1000])).toBe(true);
  await page.evaluate(
    ([up, end]) =>
      import('/app/js/window-live.mjs').then(({ mountFor }) => {
        mountFor(up);
        mountFor(end);
      }),
    [ids[10], ids.at(-1)],
  );
  const order = await page.locator('#main > .item').evaluateAll((ns) => ns.map((n) => /** @type {HTMLElement} */ (n).dataset.key));
  const places = order.map((key) => ids.indexOf(/** @type {string} */ (key)));
  expect(places.includes(1000), 'the focused item is still on the page').toBe(true);
  expect(places, 'mounted items in the conversation’s order').toEqual([...places].sort((a, b) => a - b));
});

test('#866 after Home, a drag of the scrollbar to the middle stays at the middle', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Home');
  await frames(page);
  await settled(page);
  const target = await page.evaluate(() => document.scrollingElement.scrollHeight / 2);
  expect(await shownAfter(page, () => scrollTo(0, document.scrollingElement.scrollHeight / 2)), 'an item across the middle of the view').toBe(true);
  await settled(page);
  const y = await page.evaluate(() => scrollY);
  expect(y, `the view stayed near where it was dragged, ${Math.round(target)}, not back at the top`).toBeGreaterThan(target / 2);
});

/** Records whether each Home or End press was taken by the page, as the event reaches the window last. */
const recordKeys = (page) =>
  page.evaluate(() => {
    const taken = /** @type {boolean[]} */ ([]);
    /** @type {any} */ (window).taken = taken;
    addEventListener('keydown', (e) => (e.key === 'Home' || e.key === 'End') && taken.push(e.defaultPrevented));
  });

test('#866 End after a click in another scroll container scrolls that container, not the conversation', async ({ page }) => {
  await open(page);
  await recordKeys(page);
  // A pane of its own that scrolls, as the side panel, a table or a dialog does.
  await page.evaluate(() => {
    const pane = document.createElement('div');
    pane.id = 'zz-pane';
    pane.style.cssText = 'position:fixed;left:20px;top:120px;width:300px;height:200px;overflow:auto;z-index:9999;background:white';
    pane.innerHTML = '<p style="height:3000px">Plain text in a pane that scrolls.</p>';
    document.body.append(pane);
  });
  await page.locator('#zz-pane p').click({ position: { x: 20, y: 20 } });
  const before = await page.evaluate(() => scrollY);
  await page.keyboard.press('End');
  await frames(page);
  await settled(page);
  expect(await page.evaluate(() => /** @type {any} */ (window).taken), 'the page left End to the browser').toEqual([false]);
  expect(await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('zz-pane')).scrollTop), 'the pane scrolled').toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY), 'the conversation stayed where it was').toBe(before);
});

test('#866 Ctrl+Home and Shift+End stay the browser’s', async ({ page }) => {
  await open(page);
  await recordKeys(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+End');
  expect(await page.evaluate(() => /** @type {any} */ (window).taken)).toEqual([false, false]);
});

test('#866 an item with focus keeps it when the range jumps far past it', async ({ page }) => {
  const t = await open(page);
  const ids = app.store.items(t.id).map((it) => it.id);
  expect(await page.evaluate((id) => import('/app/js/needs-nav.mjs').then((m) => m.focusItem(id)), ids[1990])).toBe(true);
  const focused = () =>
    page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.closest('[data-key]')?.getAttribute('data-key') ?? null);
  expect(await focused()).toBe(ids[1990]);
  // A drag of the scrollbar to the top, far past the range, while the item keeps focus.
  await shownAfter(page, () => scrollTo(0, 0));
  await settled(page);
  expect(await focused(), 'focus stayed on the item').toBe(ids[1990]);
});
