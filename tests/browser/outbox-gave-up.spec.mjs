// A send whose POST keeps failing while the page’s stream stays open was tried again a few times (#1126), and then
// waited for a reconnect that an open stream never brings, saying “Waiting for the connection” all along. Now its row
// says it’s being tried again; past the quick tries, it’s tried every 30 s on its own, with a line saying Postbox
// hasn’t confirmed it, and Send now. Offline, it still waits for the connection.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Each held session’s release, once its turn has reached the adapter. */
const releases = new Map();
const holds = new Set();

test.beforeAll(async () => {
  app = await startPostbox('outbox-gave-up');
  app.rt.adapters.register({
    name: 'claude-code',
    folderFor: async () => app.root,
    async deliver(session, _message, ctx) {
      if (holds.delete(session.id)) {
        await new Promise((resolve) => {
          releases.set(session.id, resolve);
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
      }
      ctx.text('Done.');
    },
  });
});
test.afterAll(async () => {
  for (const release of releases.values()) release();
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A conversation with one agent, busy in a turn held open, and the page on it. */
async function busyAgent(page) {
  const n = ++count;
  const persona = app.rt.createPersona({ handle: `worker-${n}`, backend: 'claude-code' });
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Gave up ${n}`, personaIds: [persona.id] });
  const [worker] = app.rt.sessionsIn(thread.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  holds.add(worker.id);
  app.rt.sendMessage(thread.id, { text: `@${worker.handle} start the long work` });
  await expect.poll(() => releases.has(worker.id)).toBe(true);
  return { thread, worker };
}

const row = (page, text) => page.locator('.composer .queued').filter({ hasText: text });
const POSTS = '**/api/threads/*/messages';

test('a send that keeps failing with the stream open is tried every 30 s on its own, says so, and offers Send now', async ({ page }) => {
  await page.clock.install();
  const { thread, worker } = await busyAgent(page);
  let posts = 0;
  await page.route(POSTS, (route) => {
    posts++;
    return route.abort('connectionreset');
  });
  allowPageError(page, /ERR_CONNECTION_RESET|NetworkError|Failed to load resource/, { times: 50 });
  await page.locator('#composer-input').fill(`@${worker.handle} never gets through`);
  await page.locator('#composer-input').press('Enter');
  await expect(row(page, 'never gets through'), 'while it’s tried again').toContainText('Trying again');
  await expect(page.locator('.composer'), 'the connection is open').not.toContainText('Waiting for the connection');

  // Past the quick tries (1, 2, 4 and 8 s): a line says what the page saw, and it goes on trying on its own.
  await page.clock.runFor(20_000);
  const slow = page.locator('.composer .outbox-slow');
  await expect(slow).toContainText('didn’t confirm');
  await expect.poll(() => posts, { message: 'the first try and four quick ones' }).toBe(5);
  await page.clock.runFor(30_000);
  await expect.poll(() => posts, { message: 'and one more 30 s on' }).toBe(6);
  await expect(page.locator('.composer'), 'still not the connection').not.toContainText('Waiting for the connection');

  // Send now doesn’t wait for the next try.
  await slow.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => posts, { message: 'Send now tries at once' }).toBe(7);

  // Once a try gets through, it goes with nothing from the person.
  await page.unroute(POSTS);
  await page.clock.runFor(30_000);
  await expect
    .poll(() => (app.rt.s.threads[thread.id].queue ?? []).map((q) => q.text), { message: 'the next try sends it' })
    .toEqual([`@${worker.handle} never gets through`]);
  await expect(row(page, 'never gets through')).toHaveCount(0);
  await expect(slow).toHaveCount(0);
  releases.get(worker.id)?.();
});

test('offline, a failed send still waits for the connection, with no Send now', async ({ page }) => {
  await page.clock.install();
  const { worker } = await busyAgent(page);
  allowPageError(page, /ERR_INTERNET_DISCONNECTED/, { times: 50 });
  await page.context().setOffline(true);
  await page.locator('#composer-input').fill(`@${worker.handle} written offline`);
  await page.locator('#composer-input').press('Enter');
  await expect(row(page, 'written offline')).toContainText('Waiting for the connection');
  await page.clock.runFor(60_000);
  await expect(row(page, 'written offline')).toContainText('Waiting for the connection');
  await expect(page.locator('.composer .outbox-slow')).toHaveCount(0);
  await page.context().setOffline(false);
  releases.get(worker.id)?.();
});
