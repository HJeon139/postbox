// Home and End over a short conversation, one with no window (#1884). The page took them only in a long room (#866),
// and left a short room’s to the browser’s smooth keyboard scroll, which twice on CI’s Linux runner moved nothing at
// all. Now the page takes them in every room, and leaves them alone where they belong to something else: a field, a
// select, an editable block, another scroller the person is in (Work, a command’s output), or a dialog.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { longRoom } from './message-address.mjs';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('page-edge-keys');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 800 } });

/** Opens a room of 60 messages at its end, and records whether the page takes each Home or End, as the window hears it last. */
async function open(page, title, path = '') {
  const room = longRoom(app, title);
  await page.goto(`${app.origin}/#/t/${room.t.id}${path}`);
  await synced(page, app);
  await expect(page.locator('#main > .item').last()).toBeVisible();
  await settled(page);
  await page.evaluate(() => {
    const taken = /** @type {boolean[]} */ ([]);
    /** @type {any} */ (window).taken = taken;
    addEventListener('keydown', (e) => (e.key === 'Home' || e.key === 'End') && taken.push(e.defaultPrevented));
  });
  return room;
}
const taken = (page) => page.evaluate(() => /** @type {any} */ (window).taken);
const top = (page) => page.evaluate(() => Math.round(scrollY));
const atEnd = (page) => page.evaluate(() => Math.round(scrollY + innerHeight) >= document.documentElement.scrollHeight - 1);

/** Presses key where focus is, and checks the page left it to the browser and the conversation didn’t move. */
async function leftAlone(page, key = 'End') {
  const before = await top(page);
  await page.keyboard.press(key);
  await frames(page);
  await settled(page);
  expect(await taken(page), `the page left ${key} to the browser`).toEqual([false]);
  expect(await top(page), 'the conversation stayed where it was').toBe(before);
}

test('#1884 in a short room, Home and End are the page’s: Home goes to the top, End to the end', async ({ page }) => {
  await open(page, 'Keys, short room');
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Home');
  await expect.poll(() => top(page), { message: 'Home goes to the top' }).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(() => atEnd(page), { message: 'End goes to the end' }).toBe(true);
  expect(await taken(page), 'the page took both, not the browser’s smooth scroll').toEqual([true, true]);
});

test('#1884 End in the composer is the field’s', async ({ page }) => {
  await open(page, 'Keys, composer');
  await page.locator('#composer-input').click();
  await leftAlone(page);
});

test('#1884 End in a select is the select’s', async ({ page }) => {
  await open(page, 'Keys, select');
  await page.evaluate(() => {
    const select = document.createElement('select');
    select.id = 'zz-select';
    select.style.cssText = 'position:fixed;left:20px;top:120px;z-index:9999';
    for (const n of ['One', 'Two', 'Three']) select.append(new Option(n));
    document.body.append(select);
  });
  await page.locator('#zz-select').focus();
  await leftAlone(page);
});

test('#1884 End in an editable block is the block’s', async ({ page }) => {
  await open(page, 'Keys, editable');
  await page.evaluate(() => {
    const block = document.createElement('div');
    block.id = 'zz-edit';
    block.contentEditable = 'true';
    block.style.cssText = 'position:fixed;left:20px;top:120px;width:300px;z-index:9999;background:white';
    block.textContent = 'Text you can edit.';
    document.body.append(block);
  });
  await page.locator('#zz-edit').click();
  await leftAlone(page);
});

test('#1884 End after a click in Work is left to Work, and doesn’t scroll the conversation', async ({ page }) => {
  await open(page, 'Keys, Work', '?work');
  const body = page.locator('.workpane .wp-body');
  // Work long enough to scroll, as a turn’s steps and blocks make it.
  await body.evaluate((b) =>
    b.append(Object.assign(document.createElement('p'), { id: 'zz-tall', textContent: 'A long turn.', style: 'height:3000px;flex:none' })),
  );
  await page.locator('#zz-tall').click({ position: { x: 20, y: 20 } });
  await leftAlone(page);
});

test('#1884 End in a command’s output scrolls the output', async ({ page }) => {
  const room = await open(page, 'Keys, command output');
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const cmd = arrange.post(app.rt, room.t.id, {
    kind: 'command',
    command: 'seq 200',
    cwd: '/tmp',
    status: 'done',
    text: lines,
    exitCode: 0,
    ms: 10,
    cut: false,
  });
  const out = page.locator(`[data-key="${cmd.id}"] .cmd-out`);
  await out.focus();
  await settled(page);
  await leftAlone(page);
  expect(await out.evaluate((o) => o.scrollTop), 'the output scrolled').toBeGreaterThan(0);
});

// The browser’s own End bubbles from a dialog that doesn’t scroll to the page behind it: so in a dialog, the page leaves
// End to a scroller in the dialog and takes it otherwise, to move nothing.
test('#1884 End in a dialog doesn’t scroll the conversation behind it', async ({ page }) => {
  await open(page, 'Keys, dialog');
  // Up from the end, so an End that reached the conversation would move it.
  await page.evaluate(() => scrollTo(0, 0));
  await settled(page);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('appearance')));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('End');
  await frames(page);
  await settled(page);
  expect(await top(page), 'the conversation stayed at the top').toBe(0);
});
