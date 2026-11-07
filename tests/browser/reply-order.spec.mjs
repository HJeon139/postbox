// A reply sits in the conversation where its agent wrote it (server/reply-segment.mjs, wordsSegment): a message
// posted while the agent works comes before the words it writes after it, and the steps stay where the agent began.
// So do words after a tool call, once someone else spoke while it ran.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let thread;
/** @type {any} */
let room;
let write = () => {};
let looked = () => {};

test.beforeAll(async () => {
  const written = new Promise((resolve) => {
    write = resolve;
  });
  const read = new Promise((resolve) => {
    looked = resolve;
  });
  app = await startPostbox('reply-order');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(session, _message, ctx) {
      if (session.handle === 'greeter') return ctx.text('Hi.');
      if (session.handle === 'asker') {
        ctx.text('Let me look.');
        ctx.activity({ id: 'look', label: 'Read answer.txt', state: 'running' });
        await read;
        ctx.activity({ id: 'look', label: 'Read answer.txt', state: 'done', ms: 10 });
        return ctx.text('The answer is 42.');
      }
      ctx.activity({ id: 'read', label: 'Read the file', state: 'done', ms: 10 });
      await written;
      ctx.text('Here’s what I found.');
    },
  });
  const projectId = Object.values(app.store.state.projects)[0].id;
  const persona = app.rt.createPersona({ handle: 'reader' });
  thread = app.rt.createThread({ projectId, title: 'Reply order', personaIds: [persona.id] });
  const asker = app.rt.createPersona({ handle: 'asker' });
  const greeter = app.rt.createPersona({ handle: 'greeter' });
  room = app.rt.createThread({ projectId, title: 'After a tool call', personaIds: [asker.id, greeter.id] });
});

test.afterAll(async () => {
  write();
  looked();
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

test('words after a tool call come after what was said while it ran; the words before it stay put', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  app.rt.sendMessage(room.id, { text: '@asker what is the answer?' });
  await expect.poll(() => app.store.items(room.id).some((it) => it.text === 'Let me look.'), { message: 'the words before the Read' }).toBe(true);
  app.rt.sendMessage(room.id, { text: '@greeter hi' });
  await expect.poll(() => app.store.items(room.id).find((it) => it.text === 'Hi.')?.status, { message: 'greeter’s reply' }).toBe('done');
  looked();
  await expect.poll(() => app.store.items(room.id).find((it) => it.text === 'The answer is 42.')?.status, { message: 'the words after it' }).toBe('done');
  await synced(page, app);

  const order = await page.locator('.transcript > [data-key]').evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''));
  const at = (words) => order.findIndex((t) => t.includes(words));
  expect.soft(at('Let me look.'), 'the words before the Read').toBeGreaterThanOrEqual(0);
  expect.soft(at('Let me look.'), 'stay above the message').toBeLessThan(at('@greeter hi'));
  expect.soft(at('Hi.'), 'greeter’s reply follows the message').toBeGreaterThan(at('@greeter hi'));
  expect.soft(at('The answer is 42.'), 'the words after the Read come after greeter’s reply').toBeGreaterThan(at('Hi.'));
});
