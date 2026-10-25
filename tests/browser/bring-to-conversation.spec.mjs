// bring_to_conversation (#128): an agent the person asks to post something in the main chat posts it there, shown as
// shared by it from the thread. The person asked in a side thread before #372; they can’t write in one now, so they
// ask in a topic thread. A room of its own (tests/browser/side-threads.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend, sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('bring-to-conversation');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const words = async (locator) => (await locator.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

test('an agent the person asked in a topic thread posts in the conversation with bring_to_conversation (#128)', async ({ page }) => {
  const { rt, store } = app;
  const r = sideRoom(app, 'Brought');
  const root = rt.addItem(r.room.id, {
    kind: 'agent',
    sessionId: r.researcher.id,
    personaId: r.researcher.personaId,
    handle: 'researcher',
    text: 'The 1908 edition drops two chapters.',
    status: 'done',
  });
  const topic = rt.startTopic(r.room.id, root.id).threadId;
  held.scripts.set(r.researcher.id, (ctx) => {
    ctx.tools.bring_to_conversation({ text: 'The editions, for the main chat.' });
    ctx.text('Posted it in the conversation.');
  });
  rt.sendMessage(topic, { text: '@researcher post the editions in the main chat' });
  await expect.poll(() => store.items(r.room.id).some((x) => x.kind === 'shared' && x.agent), { message: 'the agent’s post' }).toBe(true);
  await r.idle();
  await page.goto(`${app.origin}/#/t/${r.room.id}`);
  await synced(page, app);
  const head = page.locator('#main .shared-card', { hasText: 'The editions, for the main chat.' }).locator('.shared-head');
  await expect(head).toBeVisible();
  expect(await words(head)).toEqual([`From the thread “${store.state.threads[topic].title}” · shared by @researcher in a turn you started Open thread`]);
});
