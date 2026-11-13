// open_topic in the page (#637, #720): a topic an agent opened with open_topic opens in the panel from the link under
// its message, as one the person opened does. The agent posts there as it opens it, so the link reads “1 reply”, not
// “Thread”. A room of its own (tests/browser/side-threads.mjs).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend, sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('open-topic');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a topic an agent opened with open_topic opens in the panel from its reply count (#720)', async ({ page }) => {
  const { rt, store } = app;
  const r = sideRoom(app, 'Opened by an agent');
  const root = arrange.post(rt, r.room.id, { kind: 'user', text: 'Which editions differ?', status: 'done' });
  held.scripts.set(r.researcher.id, (ctx) => {
    ctx.tools.open_topic({ itemId: root.id, message: 'The 1908 edition drops two chapters.' });
    ctx.text('Answered in a topic thread.');
  });
  rt.sendMessage(r.room.id, { text: '@researcher open a thread on my question' });
  await expect.poll(() => store.items(r.room.id).find((x) => x.id === root.id)?.replies, { message: 'the agent’s reply in the topic' }).toBe(1);
  await r.idle();
  await page.goto(`${app.origin}/#/t/${r.room.id}`);
  await synced(page, app);
  const link = page.locator(`#main [data-key="${root.id}"] .msg-actions a.replies`);
  await expect(link).toContainText('1 reply');
  await link.click();
  await expect(page.locator('.sidepanel .item', { hasText: 'The 1908 edition drops two chapters.' }), 'the agent’s message, in the panel').toBeVisible();
});
