// bring_to_conversation (#128, #382): an agent in a topic thread posts in the main chat, shown as posted by it from the
// thread: what the person asked for there, or the topic’s outcome in a turn another agent started (#382). The person
// asked in a side thread before #372; they can’t write in one now, so they ask in a topic thread. A room of its own
// (tests/browser/side-threads.mjs).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
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
  const root = arrange.post(rt, r.room.id, {
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
  expect(await words(head)).toEqual([`From the thread “${store.state.threads[topic].title}” · posted by researcher Open thread`]);
});

// #382: an agent opens a topic for a review on its own message, and the agent it asks there posts the review’s outcome
// to the conversation, though no person asked in the topic. The post names no one, so it wakes no one.
test('an agent posts a topic’s outcome in the conversation in a turn another agent started (#382)', async ({ page }) => {
  const { rt, store } = app;
  const r = sideRoom(app, 'Reviewed in a topic');
  const root = arrange.post(rt, r.room.id, {
    kind: 'agent',
    sessionId: r.researcher.id,
    personaId: r.researcher.personaId,
    handle: 'researcher',
    text: 'PR #12 is up: the editions table.',
    status: 'done',
  });
  // @researcher opens the topic on its own message and asks @indexer there.
  held.scripts.set(r.researcher.id, (ctx) => {
    ctx.tools.open_topic({ itemId: root.id, message: '@indexer review PR #12 here.' });
    ctx.text('Asked for a review in a topic thread.');
  });
  // @indexer, woken by that mention, posts the outcome and answers in the topic. Its answer goes back to @researcher
  // there (#1518), which ends the exchange with a reaction.
  held.scripts.set(r.indexer.id, (ctx) => {
    ctx.tools.bring_to_conversation({ text: 'Review of PR #12: approved. The docs are left.' });
    ctx.text('Approved; the outcome is in the conversation.');
    held.scripts.set(r.researcher.id, (next) => {
      const answer = store.items(ctx.thread.id).findLast((x) => x.handle === 'indexer');
      next.tools.react({ id: answer.id, emoji: '✅' });
    });
  });
  const before = held.turns.length;
  rt.sendMessage(r.room.id, { text: '@researcher get PR #12 reviewed' });
  await expect.poll(() => store.items(r.room.id).find((x) => x.id === root.id)?.replies, { message: 'the review’s messages in the topic' }).toBe(2);
  await r.idle();
  const topic = store.items(r.room.id).find((x) => x.id === root.id).topicId;
  // No turn ran in the conversation after the person’s: the post names no one, so it woke no one.
  expect(held.turns.slice(before).map((t) => [t.sessionId, t.thread])).toEqual([
    [r.researcher.id, r.room.id],
    [r.indexer.id, topic],
    [r.researcher.id, topic],
  ]);
  await page.goto(`${app.origin}/#/t/${r.room.id}`);
  await synced(page, app);
  await expect(page.locator(`#main [data-key="${root.id}"] .msg-actions a.replies`), 'the topic on the message it opened from').toContainText('2 replies');
  const head = page.locator('#main .shared-card', { hasText: 'Review of PR #12: approved. The docs are left.' }).locator('.shared-head');
  await expect(head).toBeVisible();
  expect(await words(head)).toEqual([`From the thread “${store.state.threads[topic].title}” · posted by indexer Open thread`]);
});
