// The transcript window, W5 (#866): screen-reader structure and keys across the window. Each item that draws is an
// article, and with the window on each mounted item says its place in the conversation (aria-posinset of
// aria-setsize), counting only the items that draw: a reply replaced by its replay draws nothing. The transcript is
// busy while the range moves. It isn’t a feed: a feed may hold only articles, and the welcome and the host-turns row
// aren’t, and it promises Page Up/Down keys the page leaves to the browser (#866, the window design’s “Screen readers
// (W5)”). Alt+↑/↓, Home and End step through those items, mounting one that’s off the page.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const COUNT = 3000;
// Just over the window’s ceiling (240), so the window holds it, and small enough to mount whole with the flag off.
const JUST_OVER = 300;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
let small = '';
let gaps = '';
let forms = '';
test.beforeAll(async () => {
  app = await startPostbox('window-w5');
  app.rt.adapters.register({ name: 'mock', async deliver() {} });
  const projectId = Object.values(app.rt.s.projects)[0].id;
  room = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [] }).id;
  seedBigRoom(app.store, room, { count: COUNT });
  small = app.rt.createThread({ projectId, title: `${JUST_OVER} items`, personaIds: [] }).id;
  seedBigRoom(app.store, small, { count: JUST_OVER });
  gaps = app.rt.createThread({ projectId, title: `${JUST_OVER} items, some replaced`, personaIds: [] }).id;
  seedBigRoom(app.store, gaps, { count: JUST_OVER });
  const asker = app.rt.createPersona({ handle: 'asker' });
  forms = app.rt.createThread({ projectId, title: 'A form', personaIds: [asker.id] }).id;
  app.rt.addItem(forms, { kind: 'user', text: 'Before the form.' });
  app.rt.toolsFor(app.rt.sessionsIn(forms)[0].id).show_block({
    block: { id: 'when', type: 'form', version: 1, fallback: 'When?', fields: [{ id: 'day', label: 'Which day?', kind: 'text' }] },
  });
  app.rt.addItem(forms, { kind: 'user', text: 'After the form.' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** Opens a conversation with the window’s flag on or off. */
async function open(page, id, on = true) {
  await page.addInitScript((flag) => (flag ? localStorage.setItem('pb-window', 'on') : localStorage.removeItem('pb-window')), on);
  await page.goto(`${app.origin}/#/t/${id}`);
  await synced(page, app);
  await expect(page.locator('#main > .item:not([hidden])').last()).toBeVisible();
  await settled(page);
}

/** The ids of a conversation’s items that draw, in order: a reply replaced by its replay draws nothing (#120). */
const counted = (id) =>
  app.store
    .items(id)
    .filter((it) => !(it.kind === 'agent' && it.status === 'replaced'))
    .map((it) => it.id);
const focusedKey = (page) => page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement?.closest('#main > [data-key]'))?.dataset.key);
const firstKey = (page) => page.locator('#main > .item:not([hidden])').first().getAttribute('data-key');
const item = (page, key) => page.locator(`#main > [data-key="${key}"]`);
/** Focuses an item without scrolling to it, as Alt+↑/↓ leaves one, so the range doesn’t grow to the next. */
const focusInPlace = (page, key) => item(page, key).evaluate((n) => /** @type {HTMLElement} */ (n).focus({ preventScroll: true }));

/** Each mounted article’s key, aria-posinset and aria-setsize. */
const places = (page) =>
  page
    .locator('#main > [role="article"]')
    .evaluateAll((ns) => ns.map((n) => ({ key: n.getAttribute('data-key'), at: n.getAttribute('aria-posinset'), of: n.getAttribute('aria-setsize') })));

/** Every mounted article says its place among the items that draw, and how many there are; the range has no holes. */
async function expectPlaces(page, id, label) {
  const ids = counted(id);
  const index = new Map(ids.map((k, i) => [k, i]));
  const rows = await places(page);
  expect(rows.length, `${label}: articles are mounted`).toBeGreaterThan(0);
  for (const [i, r] of rows.entries()) {
    expect.soft(r.at, `${label}: ${r.key}’s place`).toBe(String((index.get(r.key ?? '') ?? -2) + 1));
    expect.soft(r.of, `${label}: ${r.key}’s set size`).toBe(String(ids.length));
    if (i) expect.soft(Number(r.at), `${label}: ${r.key} follows the one before it`).toBe(Number(rows[i - 1].at) + 1);
  }
}

/** Wheels up until the range grows above what it mounted. */
async function growUp(page) {
  const first = await firstKey(page);
  await page.mouse.move(400, 400);
  await expect(async () => {
    await page.mouse.wheel(0, -2500);
    expect(await firstKey(page)).not.toBe(first);
  }, 'the range grew up').toPass();
  await settled(page);
}

test('#866 with the window on, each mounted item says its place and the count, through a growth and an add', async ({ page }) => {
  await open(page, room);
  await expectPlaces(page, room, 'opened');
  await growUp(page);
  await expectPlaces(page, room, 'grown up');
  const size = counted(room).length;
  app.rt.addItem(room, { kind: 'user', text: 'One more, at the end.' });
  await synced(page, app);
  await expect
    .poll(async () => [...new Set((await places(page)).map((r) => r.of))], { message: 'every mounted item counts the new one' })
    .toEqual([String(size + 1)]);
  await expectPlaces(page, room, 'after an add');
});

test('#866 the transcript is busy while the range moves, and not once it has moved', async ({ page }) => {
  await open(page, room);
  await page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.querySelector('#main'));
    const seen = /** @type {(string | null)[]} */ ([]);
    /** @type {any} */ (window).busySeen = seen;
    new MutationObserver(() => seen.push(el.getAttribute('aria-busy'))).observe(el, { attributes: true, attributeFilter: ['aria-busy'] });
  });
  await growUp(page);
  const seen = await page.evaluate(() => /** @type {any} */ (window).busySeen);
  expect(seen, 'busy while the range grew').toContain('true');
  await expect(page.locator('#main'), 'not busy once it has').not.toHaveAttribute('aria-busy', 'true');
});

test('#866 Alt+↑ and Alt+↓ across the range’s edges reach the next item, mounted and focused', async ({ page }) => {
  await open(page, room);
  const ids = counted(room);
  const top = /** @type {string} */ (await firstKey(page));
  const above = ids[ids.indexOf(top) - 1];
  await expect(item(page, above), 'the item above the range is off the page').toHaveCount(0);
  await focusInPlace(page, top);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => focusedKey(page), { message: 'Alt+↑ reaches the item above the range' }).toBe(above);
  await expect(item(page, above)).toBeInViewport();
  // A jump far up leaves the newest items off the page below the range.
  await page.evaluate((id) => import('/app/js/needs-nav.mjs').then((m) => m.focusItem(id)), ids[1500]);
  await settled(page);
  const bottom = /** @type {string} */ (await page.locator('#main > .item:not([hidden])').last().getAttribute('data-key'));
  const below = ids[ids.indexOf(bottom) + 1];
  await expect(item(page, below), 'the item below the range is off the page').toHaveCount(0);
  await focusInPlace(page, bottom);
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => focusedKey(page), { message: 'Alt+↓ reaches the item below the range' }).toBe(below);
  await expect(item(page, below)).toBeInViewport();
});

for (const on of [true, false]) {
  test(`#866 Alt+↓ steps over a replaced reply to the next item that draws, with the window ${on ? 'on' : 'off'}`, async ({ page }) => {
    await open(page, gaps, on);
    const list = app.store.items(gaps);
    // The last reply with an item after it, so all three are in the range the window opens on.
    const at = list.findLastIndex((it, i) => i < list.length - 1 && it.kind === 'agent');
    const [prev, gone, next] = [list[at - 1].id, list[at].id, list[at + 1].id];
    app.store.emit('item.patch', { threadId: gaps, id: gone, patch: { status: 'replaced', text: '' } });
    await synced(page, app);
    await expect(item(page, gone), 'the replaced reply draws nothing').toBeHidden();
    await item(page, prev).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => focusedKey(page), { message: 'Alt+↓ steps over it' }).toBe(next);
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => focusedKey(page), { message: 'Alt+↑ steps back over it' }).toBe(prev);
    if (on) {
      const [p, n] = await Promise.all([prev, next].map((k) => item(page, k).getAttribute('aria-posinset')));
      expect(Number(n), 'the replaced reply takes no place').toBe(Number(p) + 1);
      await expectPlaces(page, gaps, 'after the reply was replaced');
    }
  });
}

for (const [on, id] of /** @type {const} */ ([
  [true, () => room],
  [false, () => small],
])) {
  test(`#866 Home and End on an item go to the first and last items, with the window ${on ? 'on' : 'off'}`, async ({ page }) => {
    await open(page, id(), on);
    const ids = counted(id());
    await item(page, ids.at(-1)).focus();
    await page.keyboard.press('Home');
    await expect.poll(() => focusedKey(page), { message: 'Home goes to the first item' }).toBe(ids[0]);
    await expect(item(page, ids[0])).toBeInViewport();
    await page.keyboard.press('End');
    await expect.poll(() => focusedKey(page), { message: 'End goes to the last item' }).toBe(ids.at(-1));
    await expect(item(page, ids.at(-1))).toBeInViewport();
  });
}

test('#866 Home and End in a field inside an item move its caret, and focus stays in the field', async ({ page }) => {
  await open(page, forms);
  const field = page.getByRole('textbox', { name: 'Which day?' });
  await field.click();
  await page.keyboard.type('Friday');
  await page.keyboard.press('Home');
  await page.keyboard.type('X');
  await page.keyboard.press('End');
  await page.keyboard.type('Y');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('XFridayY');
});

for (const [on, id] of /** @type {const} */ ([
  [true, () => room],
  [false, () => small],
])) {
  test(`#866 each item that draws is an article, in a transcript that isn’t a feed, with the window ${on ? 'on' : 'off'}`, async ({ page }) => {
    await open(page, id(), on);
    await expect(page.locator('#main'), 'not a feed, which may hold only articles').not.toHaveAttribute('role', 'feed');
    const items = await page
      .locator('#main > .item')
      .evaluateAll((ns) =>
        ns.filter((n) => !(/** @type {HTMLElement} */ (n).hidden) && n.getAttribute('role') !== 'article').map((n) => n.outerHTML.slice(0, 120)),
      );
    expect(items, 'every item that draws is an article').toEqual([]);
    if (!on) await expect(page.locator('#main > [aria-posinset]'), 'with every item on the page, the browser counts them').toHaveCount(0);
  });
}

/** What axe finds in the transcript against WCAG 2.1 A and AA, rule by rule, with a few of the nodes. */
async function axe(page) {
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover (demo-a11y.spec.mjs).
  await page.evaluate(`${AXE};0`);
  return page.evaluate(() =>
    /** @type {any} */ (window).axe
      .run({ include: ['#main'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
      .then((/** @type {any} */ r) =>
        r.violations.map((/** @type {any} */ v) => ({ rule: v.id, nodes: v.nodes.slice(0, 3).map((/** @type {any} */ n) => n.target.join(' ')) })),
      ),
  );
}

for (const on of [true, false])
  for (const width of [375, 1280])
    test(`#866 axe finds nothing in the transcript at ${width} px, with the window ${on ? 'on' : 'off'}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 812 });
      await open(page, gaps, on);
      expect(await axe(page)).toEqual([]);
    });
