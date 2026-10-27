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
  store.emit('project', { id: 'pr_other', name: 'Other project', folder: app.root });
  const persona = rt.createPersona({ handle: 'shelly', backend: 'mock', permissionMode: 'auto', tools: [] });
  for (const title of ['First', 'Second']) threads.push(rt.createThread({ projectId: 'pr_shell', title, personaIds: [persona.id] }));
  threads.push(rt.createThread({ projectId: 'pr_other', title: 'Other conversation', personaIds: [persona.id] }));
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
  // An agent’s session is archived only with its conversation (#320).
  await expect(page.getByRole('button', { name: 'Archive instead' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('deleting a one-to-one conversation’s only agent leaves the conversation, which goes with it (#320)', async ({ page }) => {
  const persona = Object.values(app.store.state.personas).find((p) => p.handle === 'shelly');
  const doomed = app.rt.createThread({ projectId: 'pr_shell', title: 'Doomed', personaIds: [persona.id] });
  await open(page, `#/t/${doomed.id}`);
  await page.locator('.rail .agent-row .agent-btn').first().click();
  await page.locator('.backdrop .dialog.quick').getByRole('button', { name: 'Delete session…' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Delete session', exact: true }).click();
  // Before, `#/` went back to the last conversation, this one, for the 10 s until it was erased.
  await expect(page).toHaveURL(/#\/t\//);
  await expect(page).not.toHaveURL(new RegExp(`#/t/${doomed.id}`));
});

test('nothing archives a conversation by itself: Settings has no idle archiving (#320)', async ({ page }) => {
  await open(page, `#/t/${threads[0].id}`);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.dialog').getByRole('tab', { name: 'Projects' }).click();
  await expect(page.locator('.dialog').getByText('The folder bounds the file picker')).toBeVisible();
  await expect(page.locator('.dialog').getByText(/Archive idle/)).toHaveCount(0);
});

test('an archived conversation comes back whole, with all its agents, from one Restore (#320)', async ({ page }) => {
  const room = app.rt.createThread({ projectId: 'pr_shell', title: 'Archived room', personaIds: Object.values(app.store.state.personas).map((p) => p.id) });
  app.rt.archiveThread(room.id);
  await open(page, `#/t/${room.id}`);
  await expect(page.getByRole('button', { name: /^Restore @/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore conversation' }).click();
  await expect.poll(() => app.rt.sessionsIn(room.id).map((se) => se.archived)).toEqual(app.rt.sessionsIn(room.id).map(() => false));
  await expect(page.locator('#composer-input')).toBeEnabled();
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

test('#432 the places menu focuses and marks the current project with consistent icons', async ({ page }) => {
  for (const [thread, name] of [
    [threads[0], 'Shell'],
    [threads[2], 'Other project'],
  ]) {
    await open(page, `#/t/${thread.id}`);
    await page.locator('#places-button').click();
    const menu = page.getByRole('menu', { name: 'Go to' });
    const projects = menu.getByRole('menuitem').filter({ has: page.locator('.i-folder') });
    const current = projects.filter({ hasText: new RegExp(`^${name}`) });
    await expect(current).toBeFocused();
    await expect(current).toHaveAttribute('aria-current', 'true');
    await expect(current.locator('.k')).toHaveText('✓');
    await expect(projects).toHaveCount(Object.keys(app.store.state.projects).length);
    await expect(projects.locator('.i-folder')).toHaveCount(Object.keys(app.store.state.projects).length);
    await page.keyboard.press('Escape');
  }
});
