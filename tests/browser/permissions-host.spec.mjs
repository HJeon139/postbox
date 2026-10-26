// The permissions panel for an agent on a remote host (#120): the rules it lists are this computer's settings files,
// and the agent's Claude Code reads the host's, so the panel says so. A scripted Claude Code agent, placed on a host
// that's added but never installed: nothing connects to it.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;

test.beforeAll(async () => {
  let work = '';
  app = await startPostbox('permissions-host', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(work, { recursive: true });
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
  store.emit('project', { id: 'pr_host', name: 'Host', folder: work });
  const host = rt.addHost({ name: 'build.example.com' });
  const persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask' });
  store.emit('persona', { ...store.state.personas[persona.id], remote: { hostId: host.id } });
  thread = rt.createThread({ projectId: 'pr_host', title: 'On a host', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#120 the panel for an agent on a host says its Claude Code reads the host’s settings, not the ones listed here', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.perm-panel')).toBeVisible();
  await expect(dialog).toContainText('@coder runs on build.example.com, where Claude Code reads the agent folder’s settings files there');
  await expect(dialog).toContainText('not the ones listed here from this computer');
});
