// The persona sheet’s setup controls (#57): “Uses your Claude Code setup” (on by default) and “Can publish outside
// Postbox” (off by default) appear for a real backend, with help text, work from the keyboard, and save to the
// persona; the new-agent sheet shows both with their defaults. With a stand-in Claude Code backend, which never runs
// a turn here: it only makes the real backend’s fields show. With an Antigravity CLI stand-in that reports its preferred
// Gemini model after another, the Gemini boilerplate picks the preferred one (#358; gemini-boilerplate.spec.mjs checks
// the rest of that boilerplate), and its Auto says Postbox’s hook approves routine actions. Moved from
// tools/checks/persona-setup.mjs (#303).

import { expect, test } from '@playwright/test';
import { AGY_CAPABILITIES } from '../../server/adapters/antigravity-cli.mjs';
import { failOnPageErrors, focusIs, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('persona-setup');
  app.rt.adapters.register({ name: 'claude-code', deliver: async () => {} });
  app.rt.adapters.register({
    name: 'antigravity-cli',
    capabilities: { ...AGY_CAPABILITIES, models: ['gemini-2.5-pro', 'gemini-3.8-flash-high'] },
    deliver: async () => {},
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** Settings, on its Personas tab. */
async function personas(page) {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.dialog').getByRole('tab', { name: 'Personas' }).click();
}
/** A setup checkbox, which must be visible, with its name and its help. */
async function setupBox(page, id, name, help) {
  const box = page.locator(`#${id}`);
  await expect(box).toBeVisible();
  await expect(box).toHaveRole('checkbox');
  await expect(box).toHaveAccessibleName(name);
  await expect(box, 'its help text').toHaveAccessibleDescription(help);
  return box;
}

test('#57 the persona editor shows both setup controls, with help, works from the keyboard, and saves them', async ({ page }) => {
  const persona = app.rt.createPersona({ handle: 'checker', backend: 'claude-code' });
  expect.soft([persona.usesHostSetup, persona.canPublish], 'a new persona uses your setup and can’t publish').toEqual([true, false]);
  await personas(page);
  await page.getByRole('button', { name: 'Edit @checker', exact: true }).click();
  const setup = await setupBox(page, 'pe-setup', 'Uses your Claude Code setup', /skills, commands, plugins and permission rules/);
  await expect.soft(setup, 'Isolated keeps the folder’s local file').toHaveAccessibleDescription(/folder’s local file, where Always allow saves/);
  await expect.soft(setup, 'on by default').toHaveAttribute('aria-checked', 'true');
  const publish = await setupBox(page, 'pe-publish', 'Can publish outside Postbox', /artifacts, and connectors that post or send/);
  await expect.soft(publish, 'off by default').toHaveAttribute('aria-checked', 'false');
  // Keyboard: Space and Enter toggle, and Tab moves from one to the other.
  await setup.focus();
  await page.keyboard.press('Space');
  await expect.soft(setup, 'Space turns it off').toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Tab');
  await focusIs(page, 'checkbox: Can publish outside Postbox');
  await page.keyboard.press('Enter');
  await expect.soft(publish, 'Enter turns it on').toHaveAttribute('aria-checked', 'true');
  await page.locator('.dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(
      () => {
        const p = app.store.state.personas[persona.id];
        return [p.usesHostSetup, p.canPublish];
      },
      { message: 'Save stores both on the persona' },
    )
    .toEqual([false, true]);
});

test('#57 the new-agent sheet shows both, with their defaults, on the real backend it picks', async ({ page }) => {
  await personas(page);
  await page.locator('.dialog').getByRole('button', { name: 'New agent', exact: true }).click();
  const setup = await setupBox(page, 'na-setup', 'Uses your Claude Code setup', /skills, commands, plugins and permission rules/);
  await expect(setup).toHaveAttribute('aria-checked', 'true');
  const publish = await setupBox(page, 'na-publish', 'Can publish outside Postbox', /artifacts, and connectors that post or send/);
  await expect(publish).toHaveAttribute('aria-checked', 'false');
});

test('#358 the Gemini boilerplate picks the Antigravity CLI’s preferred Gemini model, though another Gemini model comes first', async ({ page }) => {
  await personas(page);
  await page.locator('.dialog').getByRole('button', { name: 'New agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByRole('radiogroup', { name: 'Boilerplate' }).getByRole('radio', { name: 'Gemini', exact: true }).click();
  await expect.soft(dialog.getByLabel('Backend'), 'the Antigravity CLI').toHaveValue('antigravity-cli');
  await expect.soft(dialog.getByLabel('Model'), 'gemini-3.8-flash-high, not the first one listed').toHaveValue('gemini-3.8-flash-high');
  await expect.soft(dialog.getByLabel('Instructions'), 'its prompt').toHaveValue(/^# Gemini\n/);
});

test('the Antigravity CLI’s Auto says Postbox approves routine actions itself, and what still asks with a card', async ({ page }) => {
  await personas(page);
  await page.locator('.dialog').getByRole('button', { name: 'New agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByRole('radiogroup', { name: 'Boilerplate' }).getByRole('radio', { name: 'Gemini', exact: true }).click();
  const field = dialog.locator('.field').filter({ has: page.getByRole('radiogroup', { name: 'Permissions' }) });
  await field.getByRole('radio', { name: 'Auto', exact: true }).click();
  await expect(field.locator('.help')).toHaveText(/^Antigravity’s Auto: Postbox approves routine actions itself/);
  await expect(field.locator('.help')).toContainText('including writes outside Postbox through MCP tools and gh');
  await expect(field.locator('.help')).toContainText('It asks with a card before anything else, such as rm, git push, curl, or edits outside its folders.');
  await field.getByRole('radio', { name: 'Accept edits', exact: true }).click();
  await expect(field.locator('.help')).not.toContainText('Postbox approves routine actions itself');
});
