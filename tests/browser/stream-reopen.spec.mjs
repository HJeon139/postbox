// Switching conversations reconnects the stream with the page's open conversations (#1155). That reconnect is the
// page's own, from open to open: it tells the rest of the page nothing, as a connection lost and back does. Heard as a
// reconnect, it sent the outbox again, reset the app checks' retries and repainted every composer, on every switch.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('stream-reopen');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#1155 switching conversations reconnects the stream without a connection change', async ({ page }) => {
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const a = app.rt.createThread({ projectId, title: 'Room A', personaIds: [] });
  const b = app.rt.createThread({ projectId, title: 'Room B', personaIds: [] });
  app.rt.addItem(a.id, { kind: 'user', text: 'In A' });
  app.rt.addItem(b.id, { kind: 'user', text: 'In B' });
  let streams = 0;
  page.on('request', (r) => r.url().includes('/api/stream') && streams++);
  await page.goto(`${app.origin}/#/t/${a.id}`);
  await synced(page, app);
  await page.evaluate(() =>
    import('/app/js/client.mjs').then(({ client }) => {
      const w = /** @type {any} */ (window);
      w.changes = 0;
      client.on((ch) => ch.type === 'connection' && w.changes++);
    }),
  );
  const opened = streams;
  for (const id of [b.id, a.id, b.id]) {
    await page.evaluate((h) => (location.hash = h), `#/t/${id}`);
    await expect(page.locator('#main .item').first()).toBeVisible();
  }
  await expect.poll(() => streams, 'the stream reconnected for the new open conversations').toBeGreaterThan(opened);
  await synced(page, app);
  expect(await page.evaluate(() => /** @type {any} */ (window).changes)).toBe(0);
});
