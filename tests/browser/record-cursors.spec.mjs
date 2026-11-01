import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('record-cursors', { demo: false });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('a page receiving only private-event cursors reconnects at the last cursor without exposing private state', async ({ page }) => {
  const original = app.store.state.records;
  app.store.state.records = { rec_private: { parts: [{ text: 'private recipient words' }], pins: ['private pin'] } };
  const end = app.store.state.seq + 3;
  try {
    await page.route('**/api/stream*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: ${end}\nevent: cursor\ndata: {}\n\n`,
      }),
    );
    const response = page.waitForResponse((r) => r.url().endsWith('/api/state'));
    await page.goto(app.origin);
    expect(await (await response).text()).not.toMatch(/private recipient words|private pin|"records"/);
    await expect.poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq))).toBe(end);
    const next = page.waitForRequest((r) => r.url().includes('/api/stream') && new URL(r.url()).searchParams.get('since') === String(end));
    await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect()));
    await next;
    expect(await page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => JSON.stringify(client.state)))).not.toContain('private recipient words');
  } finally {
    if (original === undefined) delete app.store.state.records;
    else app.store.state.records = original;
  }
});
