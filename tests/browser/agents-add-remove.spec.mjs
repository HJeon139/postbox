// #1620: the Agents header’s + adds an agent the person has to the conversation in one pick, and − removes one, as a
// list’s + and − do in macOS. Where the sidebar is hidden, at 375 px, the conversation’s menu offers the same picks.

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

/** A conversation with @librarian alone, open in the page; @indexer is an agent the person has, not in it. */
async function opened(page) {
  const { rt } = app;
  // A retired agent, which + never offers (#1620), made once for the file.
  if (!retiree) retiree = rt.updatePersona(rt.createPersona({ handle: 'retiree' }).id, { retired: true });
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: `Shelf ${++n}`, personaIds: [arrange.persona(rt, 'librarian').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return t;
}
const handlesIn = (t) =>
  arrange
    .sessionsIn(app.rt, t.id)
    .map((x) => x.handle)
    .sort();

test.describe('at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('#1620 + adds an agent in one pick, by keyboard, and − removes it, its persona kept', async ({ page }) => {
    const t = await opened(page);
    const section = page.locator('.rail section.agents-sec');
    const plus = section.getByRole('button', { name: 'Add an agent to this conversation' });
    const minus = section.getByRole('button', { name: 'Remove an agent from this conversation' });
    // Beside the heading, on its row.
    const [head, p, m] = await Promise.all([section.locator('h2.label').boundingBox(), plus.boundingBox(), minus.boundingBox()]);
    expect(Math.abs((p?.y ?? 0) + (p?.height ?? 0) / 2 - ((head?.y ?? 0) + (head?.height ?? 0) / 2)), '+ on the heading’s row').toBeLessThan(6);
    expect((m?.x ?? 0) > (p?.x ?? 0), '− after +').toBe(true);

    // One agent: removing it would erase the conversation, so − is off and says why.
    await expect(minus).toHaveAttribute('aria-disabled', 'true');
    // And looks off, as a disabled button does.
    await expect(minus).toHaveCSS('opacity', '0.5');
    // Off, it still takes focus, and says why.
    await expect(minus).toHaveAttribute('aria-description', 'The last agent can’t be removed. Delete the conversation instead.');
    await minus.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: 'Remove an agent' }), 'a press does nothing').toHaveCount(0);
    await plus.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Add an agent' });
    await expect(menu.getByRole('menuitem', { name: /@librarian/ }), 'not one already here').toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /@retiree/ }), 'not a retired one').toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /New agent/ })).toBeVisible();
    await menu.getByRole('menuitem', { name: /@indexer/ }).focus();
    await page.keyboard.press('Enter');
    await expect(section.locator('.agent-rows li', { hasText: 'indexer' }), 'its row, at once').toBeVisible();
    // Focus goes back to the composer, as after any action (app/AGENTS.md).
    await expect(page.locator('#composer-input'), 'focus back in the composer').toBeFocused();
    expect(handlesIn(t)).toEqual(['indexer', 'librarian']);
    await expect(page.locator('.sys-line', { hasText: 'indexer joined' })).toBeVisible();

    await expect(minus, 'two agents: − is on').toHaveAttribute('aria-disabled', 'false');
    await minus.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menu', { name: 'Remove an agent' }).getByRole('menuitem', { name: 'Remove @indexer…' }).click();
    await page.getByRole('alertdialog', { name: 'Delete indexer’s session?' }).getByRole('button', { name: 'Delete session' }).click();
    await expect(section.locator('.agent-rows li', { hasText: 'indexer' })).toHaveCount(0);
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
    const section = page.locator('.rail section.agents-sec');
    await section.getByRole('button', { name: 'Remove an agent from this conversation' }).click();
    await page.getByRole('menu', { name: 'Remove an agent' }).getByRole('menuitem', { name: 'Remove @librarian…' }).click();
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

  test('#1620 where the sidebar is hidden, the conversation’s menu adds and removes an agent', async ({ page }) => {
    const t = await opened(page);
    const actions = page.locator('header.topbar #conversation-actions');
    await actions.click();
    await page.getByRole('menuitem', { name: /Add an agent/ }).click();
    await page
      .getByRole('menu', { name: 'Add an agent' })
      .getByRole('menuitem', { name: /@indexer/ })
      .click();
    await expect.poll(() => handlesIn(t)).toEqual(['indexer', 'librarian']);
    // The page has heard it too, so its menu lists it.
    await synced(page, app);
    await actions.click();
    await page.getByRole('menuitem', { name: /Remove an agent/ }).click();
    await page.getByRole('menu', { name: 'Remove an agent' }).getByRole('menuitem', { name: 'Remove @indexer…' }).click();
    await page.getByRole('alertdialog', { name: 'Delete indexer’s session?' }).getByRole('button', { name: 'Delete session' }).click();
    await expect.poll(() => handlesIn(t)).toEqual(['librarian']);
    await synced(page, app);
    // One agent left: the menu offers no Remove, as removing it would erase the conversation.
    await actions.click();
    await expect(page.getByRole('menuitem', { name: /Add an agent/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Remove an agent/ })).toHaveCount(0);
  });
});
