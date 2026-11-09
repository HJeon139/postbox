// A send whose POST fails while the page’s stream stays open, as Firefox’s does when it reuses a keep-alive
// connection the server has already closed, goes into the outbox (#1126). The outbox was sent only when the connection
// came back, which an open stream never does, so the message waited unseen: not on the server, not in the agent’s
// queue badge, with the composer saying it waited for a connection that was open. It is now sent again shortly.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Each held session’s release, once its turn has reached the adapter. */
const releases = new Map();
const holds = new Set();

test.beforeAll(async () => {
  app = await startPostbox('outbox-retry');
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
  const thread = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Outbox ${n}`, personaIds: [persona.id] });
  const [worker] = app.rt.sessionsIn(thread.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  holds.add(worker.id);
  app.rt.sendMessage(thread.id, { text: `@${worker.handle} start the long work` });
  await expect.poll(() => releases.has(worker.id)).toBe(true);
  return { thread, worker };
}

/** The page’s first message POST fails as a dropped connection would; the stream and every later POST go through. */
async function failFirstPost(page) {
  let tried = 0;
  await page.route('**/api/threads/*/messages', (route) => (tried++ ? route.continue() : route.abort('connectionreset')));
  allowPageError(page, /ERR_CONNECTION_RESET|NetworkError|Failed to load resource/);
  return () => tried;
}

test('#1126 a send whose POST fails while the stream is open is sent again, and the busy agent’s badge counts it', async ({ page }) => {
  const { thread, worker } = await busyAgent(page);
  const tried = await failFirstPost(page);
  await page.locator('#composer-input').fill(`@${worker.handle} sent while one POST fails`);
  await page.locator('#composer-input').press('Enter');
  await expect.poll(tried, { message: 'the first POST failed' }).toBeGreaterThan(0);
  expect(await page.evaluate(async () => (await import('/app/js/client.mjs')).client.connection), 'the stream stays open').toBe('open');
  await expect
    .poll(() => (app.rt.s.threads[thread.id].queue ?? []).map((q) => q.text), { message: 'the message reaches the agent’s queue', timeout: 15000 })
    .toEqual([`@${worker.handle} sent while one POST fails`]);
  const badge = page
    .locator('.agent-row')
    .filter({ hasText: worker.handle })
    .getByRole('button', { name: /queued for/ });
  await expect(badge).toHaveAccessibleName(`1 message queued for ${worker.handle}`);
  await expect(page.locator('.composer .queued'), 'no row waits for a connection that is open').toHaveCount(0);
  releases.get(worker.id)?.();
});

test('#1126 offline, a failed send still waits for the connection, and isn’t sent again meanwhile', async ({ page }) => {
  // The page’s own timers run on a clock the test moves, so a retry it would make while offline has time to fire.
  await page.clock.install();
  const { thread, worker } = await busyAgent(page);
  let posts = 0;
  page.on('request', (r) => r.url().includes('/messages') && r.method() === 'POST' && posts++);
  allowPageError(page, /ERR_INTERNET_DISCONNECTED/, { times: 50 });
  await page.context().setOffline(true);
  await page.locator('#composer-input').fill(`@${worker.handle} written offline`);
  await page.locator('#composer-input').press('Enter');
  await expect(page.locator('.composer .queued').filter({ hasText: 'written offline' })).toBeVisible();
  const first = posts;
  // Headless Chromium keeps the stream open through setOffline (queue-view.spec.mjs), so only the browser’s own
  // offline flag says not to try again. Past every retry’s delay, no POST has gone again.
  await page.clock.runFor(30_000);
  expect(posts, 'no retry while the browser says it’s offline').toBe(first);
  await page.context().setOffline(false);
  await page.evaluate(async () => (await import('/app/js/client.mjs')).connect());
  await synced(page, app);
  await expect.poll(() => (app.rt.s.threads[thread.id].queue ?? []).length).toBe(1);
  releases.get(worker.id)?.();
});
