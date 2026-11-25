// #1620, #558: a room’s members are added and removed in one place, the Members list of the room’s form in the main
// menu, whose + adds an agent the person has in one pick and whose − removes the one picked, as a list’s + and − do in
// macOS. The Agents header’s button and the conversation’s ⋯ only go there.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { allowPageError, failOnPageErrors, PHONE, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let n = 0;
/** @type {any} */
let retiree = null;
test.beforeAll(async () => {
  app = await startPostbox('agents-add-remove');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/**
 * A conversation with `@librarian` alone, or with these others too, open in the page; `@indexer` is an agent the person
 * has, not in it unless named. @param {any} page @param {string[]} [others]
 */
async function opened(page, others = []) {
  const { rt } = app;
  // A retired agent, which + never offers (#1620), made once for the file.
  if (!retiree) retiree = rt.updatePersona(rt.createPersona({ handle: 'retiree' }).id, { retired: true });
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const personaIds = ['librarian', ...others].map((handle) => arrange.persona(rt, handle).id);
  const t = rt.createThread({ projectId, title: `Shelf ${++n}`, personaIds });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return t;
}
const handlesIn = (t) =>
  arrange
    .sessionsIn(app.rt, t.id)
    .map((x) => x.handle)
    .sort();

/** The room’s form, opened from the Agents header, and its Members list’s controls. */
async function members(page, t, from = 'header') {
  if (from === 'header') await page.locator('.rail section.agents-sec').getByRole('button', { name: 'Manage this conversation’s members' }).click();
  else {
    await page.locator('header.topbar #conversation-actions').click();
    await page.getByRole('menuitem', { name: /^Manage room and members/ }).click();
  }
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const list = settings.getByRole('listbox', { name: `Members of ${t.title}` });
  await expect(list).toBeVisible();
  return {
    settings,
    list,
    row: (handle) => list.getByRole('option').filter({ has: page.locator('b', { hasText: new RegExp(`^@${handle}$`) }) }),
    plus: settings.getByRole('button', { name: `Add an agent to ${t.title}` }),
    minus: settings.getByRole('button', { name: /^Remove .+/ }),
  };
}
const LAST = 'A room keeps at least one agent. Add another first, or delete the room.';

test.describe('at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('#1620 + adds an agent in one pick, by keyboard, and with one agent − is off and says why', async ({ page }) => {
    const t = await opened(page);
    const { list, row, plus, minus } = await members(page, t);
    // The only control of membership on the page: the header has no + or − of its own.
    await expect(page.locator('.rail section.agents-sec').getByRole('button', { name: /an agent (to|from) this conversation/ })).toHaveCount(0);
    // One agent, picked: removing it would erase the conversation, so − is off, looks off, and says why.
    await expect(row('librarian')).toHaveAttribute('aria-selected', 'true');
    await expect(minus).toHaveAttribute('aria-disabled', 'true');
    await expect(minus).toHaveCSS('opacity', '0.5');
    await expect(minus).toHaveAttribute('aria-description', LAST);
    await minus.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog'), 'a press does nothing').toHaveCount(0);
    await plus.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Add an agent' });
    await expect(menu.getByRole('menuitem', { name: /@librarian/ }), 'not one already here').toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /@retiree/ }), 'not a retired one').toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /New agent/ })).toBeVisible();
    await menu.getByRole('menuitem', { name: /@indexer/ }).focus();
    await page.keyboard.press('Enter');
    await expect(row('indexer'), 'its row in the list').toBeVisible();
    await expect(list.getByRole('option').filter({ hasText: 'person' }), 'people are members too').not.toHaveCount(0);
    expect(handlesIn(t)).toEqual(['indexer', 'librarian']);
    await expect(page.locator('.sys-line', { hasText: 'indexer joined' })).toBeVisible();
    await expect(minus, 'two agents: − is on').toHaveAttribute('aria-disabled', 'false');
    // A person is in every room: picked, − is off, says why, and a press asks nothing.
    await list.getByRole('option').filter({ hasText: 'person' }).click();
    await expect(minus).toHaveAttribute('aria-description', 'A person of this Postbox is in every room. Only an agent is added to a room or removed from it.');
    await minus.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog'), 'a press does nothing').toHaveCount(0);
  });
});

test.describe('at 1280 px, with two agents', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('#1620 − by keyboard removes the picked agent after its confirm: Cancel keeps it, and a remove keeps the persona', async ({ page }) => {
    const t = await opened(page, ['indexer']);
    const { row, minus } = await members(page, t);
    await row('indexer').click();
    await expect(minus, 'it names the pick').toHaveAccessibleName(`Remove @indexer from ${t.title}…`);
    await expect(minus, 'two agents: − is on').toHaveAttribute('aria-disabled', 'false');
    const ask = page.getByRole('alertdialog', { name: 'Delete indexer’s session?' });
    await minus.focus();
    await page.keyboard.press('Enter');
    await ask.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(ask).toHaveCount(0);
    expect(handlesIn(t)).toEqual(['indexer', 'librarian']);
    await minus.focus();
    await page.keyboard.press('Enter');
    await ask.getByRole('button', { name: 'Delete session' }).focus();
    await page.keyboard.press('Enter');
    await expect(row('indexer')).toHaveCount(0);
    expect(handlesIn(t)).toEqual(['librarian']);
    expect(arrange.persona(app.rt, 'indexer'), 'the persona stays').toBeTruthy();
    await expect(minus, 'one agent again: − is off').toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('at 1280 px, a remove that races another', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('#1620 − on one of two agents, with the other removed meanwhile, keeps the conversation and says why', async ({ page }) => {
    // The server refuses the remove with a 409, which the page logs.
    allowPageError(page, /status of 409/);
    const t = await opened(page);
    await app.rt.ensureSession(t.id, arrange.persona(app.rt, 'indexer').id);
    await synced(page, app);
    const { row, minus } = await members(page, t);
    await row('librarian').click();
    await minus.click();
    const ask = page.getByRole('alertdialog', { name: 'Delete librarian’s session?' });
    await expect(ask).toBeVisible();
    // While the dialog is open, @indexer goes, so @librarian is the last agent when the person confirms.
    app.rt.deleteSession(arrange.sessionsIn(app.rt, t.id).find((x) => x.handle === 'indexer').id);
    await ask.getByRole('button', { name: 'Delete session' }).click();
    await expect(page.getByText('Couldn’t remove @librarian')).toBeVisible();
    await expect(page.getByText('@librarian is the last agent here, so removing it would delete the conversation.', { exact: false })).toBeVisible();
    expect(app.rt.store.state.threads[t.id], 'the conversation stays').toBeTruthy();
    expect(handlesIn(t)).toEqual(['librarian']);
  });
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, ...PHONE });

  test('#1620 where the sidebar is hidden, the conversation’s menu goes to the same Members list, which adds and removes', async ({ page }) => {
    const t = await opened(page);
    const { row, plus, minus } = await members(page, t, 'menu');
    // The menu itself adds and removes no one.
    await plus.click();
    await page
      .getByRole('menu', { name: 'Add an agent' })
      .getByRole('menuitem', { name: /@indexer/ })
      .click();
    await expect.poll(() => handlesIn(t)).toEqual(['indexer', 'librarian']);
    await row('indexer').click();
    await minus.click();
    await page.getByRole('alertdialog', { name: 'Delete indexer’s session?' }).getByRole('button', { name: 'Delete session' }).click();
    await expect.poll(() => handlesIn(t)).toEqual(['librarian']);
    await expect(minus, 'one agent left: − is off').toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await page.locator('header.topbar #conversation-actions').click();
    await expect(page.getByRole('menuitem', { name: /^(Add an agent|Remove an agent|Rename|Delete)/ }), 'the menu has no control of its own').toHaveCount(0);
  });
});
