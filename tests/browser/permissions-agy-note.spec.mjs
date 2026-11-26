// #416, #794: the permissions panel’s note for an Antigravity agent says what decides what it may do. In Auto that’s
// its Tools, since Auto runs what they allow with no card; in Ask me and Accept edits, its mode. Before, it said only
// that its mode decides, beside the Auto text saying its Tools do.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
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
  arrange.withAdapter(rt, {
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
  // The room’s form in the main menu holds it (#1735): the top bar’s room button, then More › Permissions….
  await page.locator('header.topbar #conversation-actions').click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Permissions…', exact: true }).click();
  const dialog = page.locator('.dialog').filter({ has: page.locator('.perm-panel') });
  await expect(dialog).toContainText('In Auto its Tools decide what runs with no card, and in Ask me and Accept edits its mode decides what asks first.');
  await expect(dialog).not.toContainText('Its mode decides what it may do.');
});
