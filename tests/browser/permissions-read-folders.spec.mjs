// #338: a folder made readable from an Antigravity read card is listed in the permissions panel as read only, for
// this conversation, and its Remove takes it out of the conversation’s readable folders only.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let work;
let thread;

test.beforeAll(async () => {
  app = await startPostbox('permissions-read-folders', {
    async prepare(root) {
      work = join(root, 'work');
      await mkdir(join(work, 'notes'), { recursive: true });
    },
  });
  const { rt, store } = app;
  rt.adapters.register({
    name: 'antigravity-cli',
    capabilities: { permissions: 'none' },
    async folderFor() {
      return work;
    },
    async deliver(_session, _message, ctx) {
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_read', name: 'Read', folder: work });
  const persona = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'ask' });
  thread = rt.createThread({ projectId: 'pr_read', title: 'Readable folders', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#338 a folder made readable from a read card is listed as read only, and Remove takes it out', async ({ page }) => {
  const se = app.rt.sessionsIn(thread.id)[0];
  const notes = join(work, 'notes');
  app.rt.updateSession(se.id, { readDirs: [notes], addDirs: [notes] });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('header.topbar button[aria-label^="Actions for"]').click();
  await page.locator('.menu button.mi', { hasText: 'Permissions…' }).click();
  const dialog = page.locator('.dialog');
  const rows = dialog.locator('.list-rows li', { hasText: notes });
  await expect(rows.filter({ hasText: 'Read only, in this conversation' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'From this conversation' })).toHaveCount(1);
  await rows
    .filter({ hasText: 'Read only, in this conversation' })
    .getByRole('button', { name: `Remove ${notes}` })
    .click();
  await expect.poll(() => app.store.state.sessions[se.id].readDirs).toEqual([]);
  expect(app.store.state.sessions[se.id].addDirs, 'the folder it may work in stays').toEqual([notes]);
  await expect(rows.filter({ hasText: 'Read only, in this conversation' })).toHaveCount(0);
});
