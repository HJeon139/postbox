// What the shell no longer has (#320): no overview page or links to it, no Archived page or Archive action, and no
// agent rings in the top bar, which the sidebar’s Agents section has. `#/` opens a conversation instead.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any[]} */
const threads = [];

test.beforeAll(async () => {
  app = await startPostbox('shell');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_shell', name: 'Shell', folder: app.root });
  const persona = rt.createPersona({ handle: 'shelly', backend: 'mock', permissionMode: 'auto', tools: [] });
  for (const title of ['First', 'Second']) threads.push(rt.createThread({ projectId: 'pr_shell', title, personaIds: [persona.id] }));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}

test('#/ opens a conversation, the one you were last in, not an overview', async ({ page }) => {
  await open(page, `#/t/${threads[1].id}`);
  await open(page, '#/');
  await expect(page).toHaveURL(new RegExp(`#/t/${threads[1].id}$`));
  await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);
});

test('nothing links to an overview: not the sidebar, the breadcrumb or the Postbox menu', async ({ page }) => {
  await open(page, `#/t/${threads[0].id}`);
  await expect(page.locator('.rail').getByRole('link', { name: /^Overview/ })).toHaveCount(0);
  await expect(page.locator('header.topbar').getByRole('link', { name: 'Overview' })).toHaveCount(0);
  await page.locator('header.topbar .brand').click();
  await expect(page.locator('.menu')).toBeVisible();
  await expect(page.locator('.menu').getByText('Overview', { exact: true })).toHaveCount(0);
});

test('no Archived page or link, and no Archive in an agent’s quick panel', async ({ page }) => {
  await open(page, `#/t/${threads[0].id}`);
  await expect(page.locator('.rail').getByRole('link', { name: /^Archived/ })).toHaveCount(0);
  await page.locator('.rail .agent-row .agent-btn').first().click();
  await expect(page.locator('.backdrop .dialog.quick')).toBeVisible();
  await expect(page.locator('.backdrop .dialog.quick').getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await open(page, '#/archived');
  await expect(page, 'the old address opens a conversation').toHaveURL(/#\/t\//);
});

test('the top bar has no agent rings: the Agents section has them', async ({ page }) => {
  await open(page, `#/t/${threads[0].id}`);
  await expect(page.locator('header.topbar pb-ring')).toHaveCount(0);
  await expect(page.locator('#top-ring-stack')).toHaveCount(0);
  await expect(page.locator('.rail .agent-row pb-ring')).toHaveCount(1);
});

test('Delete session moved from the overview’s card menu to the agent’s quick panel, with its confirmation', async ({ page }) => {
  await open(page, `#/t/${threads[0].id}`);
  await page.locator('.rail .agent-row .agent-btn').first().click();
  await page.locator('.backdrop .dialog.quick').getByRole('button', { name: 'Delete session…' }).click();
  await expect(page.getByText('Delete @shelly’s session?')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('an agent’s state changing doesn’t rebuild the conversation: a draft and its focus stay (#320)', async ({ page }) => {
  await open(page, `#/t/${threads[0].id}`);
  const composer = page.locator('#composer-input');
  await composer.fill('A draft that must survive');
  await composer.evaluate((n) => {
    n.dataset.marked = 'yes';
  });
  const se = app.rt.sessionsIn(threads[0].id)[0];
  app.rt.updateSession(se.id, { state: 'think', currentStep: 'Thinking' });
  await synced(page, app);
  app.rt.updateSession(se.id, { state: 'idle', currentStep: '' });
  await synced(page, app);
  await expect(page.locator('#composer-input'), 'the same composer, not a new one').toHaveAttribute('data-marked', 'yes');
  await expect(page.locator('#composer-input')).toHaveValue('A draft that must survive');
  await expect(page.locator('#composer-input')).toBeFocused();
});
