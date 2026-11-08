// #416, #794: the permissions panel’s note for an Antigravity agent says what decides what it may do. In Auto that’s
// its Tools, since Auto runs what they allow with no card; in Ask me and Accept edits, its mode. Before, it said only
// that its mode decides, beside the Auto text saying its Tools do (the integrator’s read of #1018 at 7d696e87).

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;

test.beforeAll(async () => {
  let work = '';
  app = await startPostbox('permissions-agy-note', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(work, { recursive: true });
    },
  });
  const { rt, store } = app;
  rt.adapters.register({
    name: 'antigravity-cli',
    capabilities: { permissions: 'none', tools: 'none' },
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_agy', name: 'Agy', folder: work });
  const persona = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'auto', tools: ['shell'] });
  thread = rt.createThread({ projectId: 'pr_agy', title: 'Antigravity note', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#416 the panel says an Antigravity agent’s Tools decide in Auto, and its mode decides otherwise', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('In Auto its Tools decide what runs with no card, and in Ask me and Accept edits its mode decides what asks first.');
  await expect(dialog).not.toContainText('Its mode decides what it may do.');
});
