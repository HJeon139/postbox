// A reply sits in the conversation where its agent wrote it (server/reply-segment.mjs, wordsSegment): a message
// posted while the agent works comes before the words it writes after it, and the steps stay where the agent began.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let thread;
let write = () => {};

test.beforeAll(async () => {
  const written = new Promise((resolve) => {
    write = resolve;
  });
  app = await startPostbox('reply-order');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_session, _message, ctx) {
      ctx.activity({ id: 'read', label: 'Read the file', state: 'done', ms: 10 });
      await written;
      ctx.text('Here’s what I found.');
    },
  });
  const persona = app.rt.createPersona({ handle: 'reader' });
  thread = app.rt.createThread({ projectId: Object.values(app.store.state.projects)[0].id, title: 'Reply order', personaIds: [persona.id] });
});

test.afterAll(async () => {
  write();
  await app?.stop();
});

failOnPageErrors(test);

test('a message posted while the agent works comes before the words it writes after it', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: '@reader look at the file' });
  await expect.poll(() => app.store.items(thread.id).filter((it) => it.kind === 'agent').length, { message: 'the reply’s first part' }).toBe(1);
  app.rt.addItem(thread.id, { kind: 'user', text: 'While you look: it’s the second one.' });
  write();
  await expect.poll(() => app.store.items(thread.id).find((it) => it.kind === 'agent' && it.text)?.status, { message: 'the words, done' }).toBe('done');
  await synced(page, app);

  const transcript = page.locator('.transcript');
  const order = await transcript.locator('> [data-key]').evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''));
  const posted = order.findIndex((t) => t.includes('While you look'));
  const words = order.findIndex((t) => t.includes('Here’s what I found.'));
  expect(posted, 'the message posted meanwhile is shown').toBeGreaterThanOrEqual(0);
  expect(words, 'the words come after it').toBeGreaterThan(posted);
  const steps = order.findIndex((t) => t.includes('Read the file'));
  expect(steps, 'the steps stay above it, where the agent began').toBeGreaterThanOrEqual(0);
  expect(steps).toBeLessThan(posted);
});
