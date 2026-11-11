// One search in the top bar (#1233): Jump to… (⌘K) also finds the open conversation’s messages (#866, W4), and ⌘F
// stays the browser’s own find. A hit jumps to the item, far up a long room too. Its index is built when the palette
// first searches, rewritten one item at a time, and a reply is found once it’s done, not while it streams.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { axe } from './remote-hosts.mjs';

// Long enough that item FAR is far above the view, short enough that a loaded CI runner syncs it within expect’s 5 s.
const COUNT = 400;

// Tracing is off: the trace's snapshot lays out each item the transcript skips (#712a) at every action, and over 400
// items the change case ran past its 30 s, 2 of 2 with the trace on, against 12 of 12 passed in 16.9 s without it.
// The page has no such cost: findAnchor is a binary search, and apps.mjs's Tab check, which read the rects of every
// focusable, walks only to the next stop since critic's P2 (tab-stop.mjs, view-skipped-tab.spec.mjs counts it).
test.use({ trace: 'off' });
const FAR = 40;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
let other = '';
test.beforeAll(async () => {
  app = await startPostbox('search');
  const projectId = Object.values(app.rt.s.projects)[0].id;
  room = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [] }).id;
  other = app.rt.createThread({ projectId, title: 'Another room', personaIds: [] }).id;
  seedBigRoom(app.store, room, { count: COUNT });
  const far = app.store.items(room)[FAR];
  app.store.emit('item.patch', { threadId: room, id: far.id, patch: { text: 'An early note about the zeppelin hangar.' } });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

async function open(page) {
  await page.goto(`${app.origin}/#/t/${room}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
}
const dialog = (page) => page.locator('.dialog.palette');
const field = (page) => dialog(page).getByRole('combobox');
const openSearch = (page) => page.getByRole('button', { name: /Jump to/ }).click();
const status = (page) => dialog(page).locator('[data-item]');

test('#1233 the top bar has one search, Jump to…, and ⌘F stays the browser’s find', async ({ page }) => {
  await open(page);
  const bar = page.locator('.topbar');
  await expect(bar.getByRole('button', { name: /search/i }), 'no second search button').toHaveCount(0);
  await expect(bar.locator('.i-search'), 'one search icon in the bar').toHaveCount(1);
  await openSearch(page);
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Jump to/ }), 'focus goes back to the button').toBeFocused();
  // The browser’s find keys, ⌘F and Firefox’s ⌘⇧F, reach the browser: none is prevented.
  const prevented = await page.evaluate(() =>
    [
      { key: 'f', metaKey: true },
      { key: 'f', ctrlKey: true },
      { key: 'F', metaKey: true, shiftKey: true },
    ].map((init) => {
      const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  );
  expect(prevented).toEqual([false, false, false]);
  await expect(dialog(page)).toHaveCount(0);
  // ⌘K opens the same palette, and it still jumps to a conversation by its title, ahead of any message hit.
  await page.locator('#main').focus();
  await page.keyboard.press('Control+K');
  await expect(field(page)).toBeFocused();
  await field(page).fill('Another room');
  await expect(dialog(page).getByRole('option').first()).toContainText('Another room');
});

test('#866 W4 a word only in an item far up the room finds it, and Enter jumps to it and focuses it', async ({ page }) => {
  await open(page);
  const far = app.store.items(room)[FAR];
  await openSearch(page);
  await field(page).fill('zeppelin');
  const hit = status(page).first();
  await expect(hit).toContainText('zeppelin');
  await expect(hit).toHaveAttribute('data-item', far.id);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  const node = page.locator(`#main > .item[data-key="${far.id}"]`);
  await expect(node).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-key]')?.getAttribute('data-key'))).toBe(far.id);
});

test('#866 W4 a change to an item shows in search, and a streaming reply is found only once it’s done', async ({ page }) => {
  await open(page);
  await openSearch(page);
  await field(page).fill('quokka');
  await expect(status(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  const se = app.rt.sessionsIn(room)[0];
  const it = app.rt.addItem(room, { kind: 'agent', sessionId: se?.id, handle: 'coder', text: '', status: 'streaming' });
  for (const w of ['A ', 'quokka ', 'sighting.']) app.store.emit('item.text', { threadId: room, id: it.id, text: w });
  await synced(page, app);
  await openSearch(page);
  await field(page).fill('quokka');
  await expect(status(page), 'not while it streams').toHaveCount(0);
  await page.keyboard.press('Escape');
  app.rt.patchItem(room, it.id, { status: 'done', text: 'A quokka sighting.' });
  await synced(page, app);
  await openSearch(page);
  await field(page).fill('quokka');
  await expect(status(page).first()).toHaveAttribute('data-item', it.id);
  // Changed again: one entry is rewritten, not the room’s, and the new words are found, the old ones aren’t.
  await page.keyboard.press('Escape');
  const writes = () => page.evaluate((id) => import('/app/js/transcript-search.mjs').then((m) => m.indexFor(id).writes), room);
  const before = await writes();
  app.rt.patchItem(room, it.id, { text: 'A wombat instead.' });
  await synced(page, app);
  expect((await writes()) - before, 'entries written for one patch').toBe(1);
  await openSearch(page);
  await field(page).fill('quokka');
  await expect(status(page)).toHaveCount(0);
  await field(page).fill('wombat');
  await expect(status(page).first()).toHaveAttribute('data-item', it.id);
});

test('#866 W4 an item’s text shows in a hit as text, never as HTML', async ({ page }) => {
  const it = app.rt.addItem(room, { kind: 'user', text: 'markup <img src=x onerror="window.__pwned=1"> axolotl', status: 'done' });
  await open(page);
  await openSearch(page);
  await field(page).fill('axolotl');
  const hit = status(page).first();
  await expect(hit).toHaveAttribute('data-item', it.id);
  await expect(hit).toContainText('<img src=x');
  await expect(dialog(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
  await expect(hit.locator('mark')).toHaveText('axolotl');
});

test('#866 W4 the palette with message hits has no accessibility problems', async ({ page }) => {
  await open(page);
  await openSearch(page);
  await field(page).fill('zeppelin');
  await expect(status(page).first()).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('#866 W4 going to another conversation, or back, closes the palette, so a hit never jumps into the room you left', async ({ page }) => {
  await open(page);
  await openSearch(page);
  await field(page).fill('zeppelin');
  await expect(status(page).first()).toBeVisible();
  await page.evaluate((id) => {
    location.hash = `#/t/${id}`;
  }, other);
  await expect(dialog(page)).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('#main > .item').last()).toBeVisible();
  // Opened again, it searches the room it’s in now, from an empty field.
  await openSearch(page);
  await expect(field(page)).toHaveValue('');
});
