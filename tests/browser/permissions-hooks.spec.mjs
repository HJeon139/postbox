// The permissions panel names the PreToolUse hooks in the settings files an agent reads (#817): Postbox’s own settings
// turn them off in every mode but Run everything, so the panel says which won’t run, and that hooks the person’s
// organization manages still do. A hook’s command is the person’s data, shown as text. A scripted Claude Code agent
// working in a temp folder, with a home of its own for the user settings.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
let persona;

test.beforeAll(async () => {
  let work = '';
  app = await startPostbox('permissions-hooks', {
    // A hook in the user’s settings, and one with markup in its command in the project’s.
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(join(work, '.claude'), { recursive: true });
      await mkdir(join(root, '.claude'), { recursive: true });
      const hooks = (command) => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
      await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(hooks('~/bin/audit-bash')));
      await writeFile(join(work, '.claude', 'settings.json'), JSON.stringify(hooks('echo "<b id=hook-markup>allow</b>" && exit 0')));
    },
  });
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_hooks', name: 'Hooks', folder: work });
  persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'auto' });
  thread = rt.createThread({ projectId: 'pr_hooks', title: 'Hooks', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Opens the panel from the conversation’s ⋯, and returns its hooks section. */
async function openHooks(page) {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const hooks = page.locator('.dialog #perm-hooks');
  await expect(hooks, 'the hooks section').toBeVisible();
  return hooks;
}

test('#817 the panel names each PreToolUse hook as text, and says it won’t run in Postbox turns', async ({ page }) => {
  const hooks = await openHooks(page);
  await expect.soft(hooks).toContainText('Bash ~/bin/audit-bash from your user settings');
  await expect.soft(hooks).toContainText('Bash echo "<b id=hook-markup>allow</b>" && exit 0 from the project’s shared settings');
  await expect.soft(page.locator('#hook-markup'), 'a hook’s command is text, never markup').toHaveCount(0);
  await expect.soft(hooks).toContainText('These don’t run in @coder’s Postbox turns, except in Run everything mode.');
  await expect.soft(hooks).toContainText('Hooks your organization manages still run');
  await expect.soft(hooks).toContainText('plugin hooks and your custom status line');
});

test('#817 in Run everything mode, the panel says the hooks run', async ({ page }) => {
  app.rt.updatePersona(persona.id, { permissionMode: 'bypass' });
  try {
    const hooks = await openHooks(page);
    await expect(hooks).toContainText('In Run everything mode, these run in @coder’s Postbox turns too.');
  } finally {
    app.rt.updatePersona(persona.id, { permissionMode: 'auto' });
  }
});
