// What the page shows of a conversation without its items (#1155): the rail’s latest conversation, the Threads page’s
// topic rows, an agent’s open asks and a delete’s confirm read each thread’s header, which the server keeps and sends
// as a header frame after the event that changed it. Each test has the page let go of the conversation’s items first,
// as it does for a conversation it hasn’t opened, then changes the conversation on the server: what the page shows
// follows the header frame. Read from the page’s own items, each would miss the change.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('thread-headers');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

let rooms = 0;
/** A conversation with an agent and a few messages, then a later one to open the page on. */
function rooms2() {
  const { rt, store } = app;
  const projectId = /** @type {any} */ (Object.values(store.state.projects)[0]).id;
  const researcher = rt.personaByHandle('researcher').id;
  const a = rt.createThread({ projectId, title: `Headers A ${++rooms}`, personaIds: [researcher] });
  // A's messages a minute old, B's half a minute: until A changes, B is the later of the two, by a clear margin.
  const now = Date.now();
  for (let i = 0; i < 5; i++) rt.addItem(a.id, { kind: 'user', text: `Message ${i}`, at: now - 60_000 + i });
  const b = rt.createThread({ projectId, title: `Headers B ${rooms}`, personaIds: [researcher] });
  rt.addItem(b.id, { kind: 'user', text: 'Elsewhere', at: now - 30_000 });
  return { projectId, a, b, sa: rt.sessionsIn(a.id)[0] };
}

/** Opens the page on a conversation, then has it let go of the named conversations’ items. */
async function openWithout(page, at, ids) {
  await page.goto(`${app.origin}/#/t/${at}`);
  await synced(page, app);
  await page.evaluate(
    (forget) =>
      import('/app/js/client.mjs').then(({ client }) => {
        for (const id of forget) client.state.items[id] = [];
      }),
    ids,
  );
}

/** Goes to a route in the same page, which keeps what the page let go of let go. */
const go = (page, hash) => page.evaluate((h) => (location.hash = h), hash);

const confirm = (id) => ({ id, type: 'confirm', version: 1, fallback: 'Go?', statement: 'Go on?', confirmLabel: 'Go' });

test('#1155 a project opens on the conversation with the latest activity, from its header', async ({ page }) => {
  const { projectId, a, b } = rooms2();
  await openWithout(page, b.id, [a.id, b.id]);
  // An app brought to the newest point in A, which the page doesn’t hold: only A’s header says A is latest now.
  const first = app.store.items(a.id)[0];
  app.rt.bringForward(a.id, first.id, { what: 'block', title: 'Message 0' });
  await synced(page, app);
  await page.evaluate((p) => {
    localStorage.removeItem(`pb-last-${p}`);
  }, projectId);
  await go(page, `#/p/${projectId}`);
  await expect(page).toHaveURL(new RegExp(`#/t/${a.id}$`));
});

test('#1155 the Threads page’s topic row counts its replies from the header', async ({ page }) => {
  const { projectId, a, b } = rooms2();
  const root = app.store.items(a.id)[0];
  const topic = app.rt.putThread({
    ...{ id: `th_topic${rooms}`, projectId, title: 'A topic', kind: 'topic', parentId: a.id, rootItemId: root.id },
    ...{ members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now(), archived: false },
  });
  await openWithout(page, b.id, [a.id, topic.id]);
  await go(page, `#/p/${projectId}/threads`);
  const card = page.locator('.thread-card', { hasText: 'A topic' });
  await expect(card).toContainText('0 replies');
  app.rt.patchItem(a.id, root.id, { replies: 3, lastReplyAt: Date.now() });
  await expect(card).toContainText('3 replies');
});

test('#1155 an agent’s open asks count the asks in its conversation’s header', async ({ page }) => {
  const { a, b, sa } = rooms2();
  app.rt.addItem(a.id, { kind: 'block', sessionId: sa.id, handle: sa.handle, valid: true, answered: false, block: confirm('h-old') });
  await openWithout(page, b.id, [a.id]);
  app.rt.addItem(a.id, { kind: 'block', sessionId: sa.id, handle: sa.handle, valid: true, answered: false, block: confirm('h-new') });
  await synced(page, app);
  const asks = () =>
    page.evaluate(
      (id) =>
        import('/app/js/client.mjs').then(async ({ client }) => (await import('/app/js/open-asks.mjs')).openAsks(client.state.sessions[id])?.text ?? null),
      sa.id,
    );
  await expect.poll(asks).toBe('2 open confirmations');
});

test('#1155 deleting a conversation counts its messages from its header', async ({ page }) => {
  const { a, b } = rooms2();
  await openWithout(page, b.id, [a.id]);
  app.rt.addItem(a.id, { kind: 'user', text: 'One more' });
  await synced(page, app);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.confirmDeleteThread(id)), a.id);
  await expect(page.getByRole('alertdialog')).toContainText('6 messages');
  await page.keyboard.press('Escape');
});
