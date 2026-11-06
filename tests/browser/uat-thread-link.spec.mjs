// The UAT driver’s thread link (#720): `pane {open: thread}` opens a message’s thread in the right pane from its
// topic’s link, which reads “1 reply · last reply …” as soon as anyone has written there. An agent-opened topic always
// has, so the driver has to find that link by its class, not its text. The “Reply in thread” case isn’t here: with the
// stream 300 ms late, that button’s topic isn’t on the page when it navigates, and the panel doesn’t open (filed). It drives the runner’s own openPane against this page, through a stand-in for
// tools/browser.mjs’s page: evaluate, and send over the DevTools protocol, as uat-view.spec.mjs does.

import { expect, test } from '@playwright/test';
import { driver } from '../../tools/uat/driver.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('uat-thread-link');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** tools/browser.mjs’s page, over this one: evaluate and send. */
async function runnerPage(page) {
  const cdp = await page.context().newCDPSession(page);
  return {
    evaluate: (/** @type {string} */ expr) => page.evaluate(expr),
    send: (/** @type {string} */ method, /** @type {any} */ params) => cdp.send(/** @type {any} */ (method), params),
  };
}

/** @researcher’s message in a thread. */
const says = (/** @type {any} */ r, /** @type {string} */ threadId, /** @type {string} */ text) =>
  app.rt.addItem(threadId, { kind: 'agent', sessionId: r.researcher.id, personaId: r.researcher.personaId, handle: 'researcher', text, status: 'done' });
async function open(page, r) {
  await page.goto(`${app.origin}/#/t/${r.room.id}`);
  await synced(page, app);
}

test('the driver opens a topic with a reply from its “1 reply” link (#720)', async ({ page }) => {
  const r = sideRoom(app, 'One reply');
  const root = says(r, r.room.id, 'The 1908 edition drops two chapters.');
  const topic = app.rt.startTopic(r.room.id, root.id).threadId;
  says(r, topic, 'Chapters 9 and 12.');
  await open(page, r);
  await expect(page.locator(`#main [data-key="${root.id}"] .msg-actions a.replies`)).toContainText('1 reply');
  const sizes = await driver(await runnerPage(page)).openPane('thread', root.id);
  expect(sizes.thread, 'the thread panel, in the right pane').not.toBeNull();
  await expect(page.locator(`.sidepanel .transcript[data-thread="${topic}"] .item`, { hasText: 'Chapters 9 and 12.' })).toBeVisible();
});
