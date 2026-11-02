import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox } from './postbox.mjs';

// A cursor stands in for an event the page may not see (server/public-state.mjs). It must move the page's place on, so
// a page that hears only cursors reconnects after them rather than before.
let app;
test.beforeAll(async () => {
  app = await startPostbox('stream-cursor', { demo: false });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('a page that hears only cursors moves its place on, and reconnects after the last one', async ({ page }) => {
  const end = app.store.state.seq + 3;
  await page.route('**/api/stream*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: `id: ${end}\nevent: cursor\ndata: {}\n\n` }),
  );
  await page.goto(app.origin);
  await expect.poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq))).toBe(end);
  const next = page.waitForRequest((r) => r.url().includes('/api/stream') && new URL(r.url()).searchParams.get('since') === String(end));
  await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect()));
  await next;
});
