import { expect, test } from '@playwright/test';
import { buildRecordBatch } from '../../shared/record-batch.mjs';
import { change, close, delivery } from '../records-fixture.mjs';
import { failOnPageErrors, startPostbox } from './postbox.mjs';

let app;
test.beforeAll(async () => {
  app = await startPostbox('record-cursors', { demo: false });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('a page receiving only private-event cursors reconnects at the last cursor without exposing private state', async ({ page }) => {
  const record = delivery('rec_private', { parts: [{ text: 'private recipient words' }] });
  await app.store.commit((state) => buildRecordBatch(state, [change('open', record)]).events);
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
    await app.store.commit((state) => buildRecordBatch(state, [close(record, 'withdrawn', { reason: 'fixture complete' })]).events);
  }
});

test('a mixed private close and public item patch keeps stream order and updates the page', async ({ page }) => {
  app.store.emit('project', { id: 'pr_records', name: 'Records', folder: app.root });
  const p = app.rt.createPersona({ handle: 'records' });
  const thread = app.rt.createThread({ projectId: 'pr_records', title: 'Mixed records', personaIds: [p.id] });
  const item = app.rt.addItem(thread.id, { kind: 'user', text: 'Before the mixed group' });
  const record = delivery('mixed_private', { conversationId: thread.id, threadId: thread.id, parts: [{ text: 'Never public recipient payload' }] });
  await app.store.commit((state) => buildRecordBatch(state, [change('open', record)]).events);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await expect(page.getByText('Before the mixed group')).toBeVisible();
  await app.store.commit(
    (state) =>
      buildRecordBatch(state, [
        close(record, 'withdrawn', { reason: 'fixture complete' }),
        { type: 'item.patch', data: { threadId: thread.id, id: item.id, patch: { text: 'After the mixed group' } } },
      ]).events,
  );
  await expect(page.getByText('After the mixed group')).toBeVisible();
  await expect.poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq))).toBe(app.store.state.seq);
  expect(await page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => JSON.stringify(client.state)))).not.toContain(
    'Never public recipient payload',
  );
});
