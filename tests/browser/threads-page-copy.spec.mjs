// The Threads page said agents talk to each other in side threads, and its empty state promised that “when an agent
// wakes another, their side thread shows here too”. Agents wake each other in the conversation now (#372), so no new
// side thread appears (UAT of 26 Nov). The page says what it lists: topic threads, and older side threads read-only.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('threads-page-copy', { demo: false });
  app.store.emit('project', { id: 'pr_quiet', name: 'Quiet project', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('the Threads page of a project with none says how to start one, and promises no side thread', async ({ page }) => {
  await page.goto(`${app.origin}/#/p/pr_quiet/threads`);
  await synced(page, app);
  const main = page.locator('main.threads-view');
  await expect(main.locator('.ov-head p')).toHaveText(
    'Threads in Quiet project. A topic thread is a branch of an agent’s session, so a side topic stays out of the conversation’s memory. Agents wake each other in the conversation; a side thread from before then stays here, read-only.',
  );
  await expect(main.locator('.empty-note')).toHaveText('No threads yet. To start one, choose Reply in thread under any message in a conversation.');
});
