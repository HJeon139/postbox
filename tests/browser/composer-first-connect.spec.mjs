// Before the page’s stream has ever opened, nothing was lost, so the composer doesn’t say it’s reconnecting (#1492).
// It said “Reconnecting… attempt 0” whenever the stream wasn’t open, the first connect included; the line went away
// when the stream opened, and the transcript, following, held the room it left below the newest message (#959’s held
// room). A real drop still says so.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-first-connect');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('before the first connect the composer says nothing of reconnecting, and the view holds no room after it', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'First connect', personaIds: [arrange.persona(rt, 'researcher').id] });
  for (let i = 1; i <= 20; i++) arrange.post(rt, t.id, { kind: 'user', text: `Question ${i}, long enough to take a line or two of the room.` });
  // The stream’s first request waits until the page has drawn the conversation, as a slow or busy computer has it.
  /** @type {() => void} */
  let letConnect = () => {};
  const connected = new Promise((r) => {
    letConnect = () => r(undefined);
  });
  await page.route('**/api/stream?**', async (route) => {
    await connected;
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  const transcript = page.locator('#main.transcript');
  await expect(transcript.locator('.item').last()).toBeVisible();
  await settled(page);
  const composer = page.locator('#main-composer, .composer').first();
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.connection)), 'the stream hasn’t opened yet').toBe('connecting');
  await expect.soft(page.getByText('Reconnecting…')).toHaveCount(0);

  letConnect();
  await synced(page, app);
  await settled(page);
  expect(await page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.connection))).toBe('open');
  const held = await transcript.evaluate((el) => Number.parseFloat(/** @type {HTMLElement} */ (el).style.marginBottom) || 0);
  expect(held, 'no room held below the newest message').toBe(0);
  await expect(transcript).toHaveAttribute('data-view-mode', 'following');
});

test('a real drop still says the page is reconnecting', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'A drop', personaIds: [arrange.persona(rt, 'researcher').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.getByText('Reconnecting…')).toHaveCount(0);
  // What client.mjs’s stream does when it drops (es.onerror).
  await page.evaluate(() =>
    import('/app/js/client.mjs').then(({ client }) => {
      client.attempts = 1;
      client.connection = 'reconnecting';
      client.emit({ type: 'connection' });
    }),
  );
  await expect(page.getByText('Reconnecting…')).toHaveCount(1);
});
