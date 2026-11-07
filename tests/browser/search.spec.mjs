// Search the conversation (#866, W4): the top bar’s Search button and ⌘⇧F (Ctrl+Shift+F) open it, ⌘F stays the
// browser’s own find, and a hit jumps to the item, far up a long room too. Its index is built when search first opens,
// rewritten one item at a time, and a reply is found once it’s done, not while it streams.

import { expect, test } from '@playwright/test';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { axe } from './remote-hosts.mjs';

const COUNT = 1500;
const FAR = 40;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room = '';
test.beforeAll(async () => {
  app = await startPostbox('search');
  const projectId = Object.values(app.rt.s.projects)[0].id;
  room = app.rt.createThread({ projectId, title: `${COUNT} items`, personaIds: [] }).id;
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
const dialog = (page) => page.locator('.dialog.search-dialog');
const field = (page) => dialog(page).getByRole('combobox', { name: 'Search this conversation' });

test('#866 W4 the Search button and Ctrl+Shift+F open search; Ctrl+F is left to the browser', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Search this conversation' }).click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Search this conversation' }), 'focus goes back to the button').toBeFocused();
  for (const keys of ['Control+Shift+F', 'Meta+Shift+F']) {
    await page.locator('#main').focus();
    await page.keyboard.press(keys);
    await expect(field(page), keys).toBeFocused();
    await page.keyboard.press('Escape');
  }
  // The browser’s find: the page lets Ctrl+F (⌘F) through untouched.
  const prevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(dialog(page)).toHaveCount(0);
});

test('#866 W4 a word only in an item far up the room finds it, and Enter jumps to it and focuses it', async ({ page }) => {
  await open(page);
  const far = app.store.items(room)[FAR];
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('zeppelin');
  const hit = dialog(page).getByRole('option').first();
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
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('quokka');
  await expect(dialog(page).getByRole('status')).toHaveText('Nothing found');
  await page.keyboard.press('Escape');
  const se = app.rt.sessionsIn(room)[0];
  const it = app.rt.addItem(room, { kind: 'agent', sessionId: se?.id, handle: 'coder', text: '', status: 'streaming' });
  for (const w of ['A ', 'quokka ', 'sighting.']) app.store.emit('item.text', { threadId: room, id: it.id, text: w });
  await synced(page, app);
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('quokka');
  await expect(dialog(page).getByRole('status'), 'not while it streams').toHaveText('Nothing found');
  await page.keyboard.press('Escape');
  app.rt.patchItem(room, it.id, { status: 'done', text: 'A quokka sighting.' });
  await synced(page, app);
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('quokka');
  await expect(dialog(page).getByRole('option').first()).toHaveAttribute('data-item', it.id);
  // Changed again: one entry is rewritten, not the room’s, and the new words are found, the old ones aren’t.
  await page.keyboard.press('Escape');
  const writes = () => page.evaluate((id) => import('/app/js/transcript-search.mjs').then((m) => m.indexFor(id).writes), room);
  const before = await writes();
  app.rt.patchItem(room, it.id, { text: 'A wombat instead.' });
  await synced(page, app);
  expect((await writes()) - before, 'entries written for one patch').toBe(1);
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('quokka');
  await expect(dialog(page).getByRole('status')).toHaveText('Nothing found');
  await field(page).fill('wombat');
  await expect(dialog(page).getByRole('option').first()).toHaveAttribute('data-item', it.id);
});

test('#866 W4 an item’s text shows in a hit as text, never as HTML', async ({ page }) => {
  const it = app.rt.addItem(room, { kind: 'user', text: 'markup <img src=x onerror="window.__pwned=1"> axolotl', status: 'done' });
  await open(page);
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('axolotl');
  const hit = dialog(page).getByRole('option').first();
  await expect(hit).toHaveAttribute('data-item', it.id);
  await expect(hit).toContainText('<img src=x');
  await expect(dialog(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
  await expect(hit.locator('mark')).toHaveText('axolotl');
});

test('#866 W4 the open search has no accessibility problems', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+Shift+F');
  await field(page).fill('zeppelin');
  await expect(dialog(page).getByRole('option').first()).toBeVisible();
  expect(await axe(page)).toEqual([]);
});
