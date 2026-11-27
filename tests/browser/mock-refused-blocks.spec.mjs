// The demo’s broken blocks scene said “If any of those can’t be shown, you’ll see my plain-text version instead”, but
// since #1319 an invalid block is refused outright and no fallback shows (UAT of 26 Nov). The mock now does what an
// agent does with a refusal: it writes what each refused block held, in words, in its reply.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('mock-refused-blocks');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the mock’s broken blocks reply says in words what each refused block held, and promises no fallback', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Broken blocks',
    personaIds: [arrange.persona(rt, 'indexer').id],
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  rt.sendMessage(t.id, { text: 'Show me the timeline' });
  await expect.poll(() => arrange.liveTurns(rt), { timeout: 15_000 }).toBe(0);
  const reply = page.locator('.transcript .md').filter({ hasText: 'Here’s the timeline' });
  await expect(reply).toContainText('Chapters by book wasn’t shown, so in words: Chapters by length: Moby-Dick 135');
  await expect(reply).not.toContainText('plain-text version');
});
