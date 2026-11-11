// A load from an earlier opening of a conversation, landing after it was closed, let go and opened again, leaves the
// newer range as it is (#1155): it would put back the room as it was before a message added while the page was
// elsewhere. A closed conversation stays warm until three others have closed after it (open-threads.mjs, WARM).
import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let a = '';
let b = '';
/** Conversations opened and closed after A, so A is let go. @type {string[]} */
const others = [];
test.beforeAll(async () => {
  app = await startPostbox('jit-race');
  const projectId = Object.values(app.rt.s.projects)[0].id;
  a = app.rt.createThread({ projectId, title: 'Room A', personaIds: [] }).id;
  b = app.rt.createThread({ projectId, title: 'Room B', personaIds: [] }).id;
  for (let i = 0; i < 5; i++) app.store.emit('item.add', { threadId: a, item: { id: `it_a${i}`, kind: 'message', handle: 'you', text: `a${i}`, at: i } });
  app.store.emit('item.add', { threadId: b, item: { id: 'it_b0', kind: 'message', handle: 'you', text: 'b0', at: 0 } });
  for (let i = 0; i < 3; i++) others.push(app.rt.createThread({ projectId, title: `Room ${i}`, personaIds: [] }).id);
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const held = (page, id) => page.evaluate((t) => import('/app/js/client.mjs').then(({ client }) => (client.state.items[t] ?? []).map((x) => x.id)), id);

test('a slow load from an earlier opening doesn’t replace the range of the opening after it', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${b}`);
  await synced(page, app);
  await settled(page);
  let first = true;
  let landed = false;
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  await page.route(`**/api/threads/${a}/items*`, async (route) => {
    if (!first) return route.continue();
    first = false;
    const res = await route.fetch(); // answered now, as of the room before the new message
    await gate;
    await route.fulfill({ response: res });
    landed = true;
  });
  // The page opens and closes A as a view of it does (open-threads.mjs): the route waits for A's first load before
  // its view mounts, so the race is between two openings of the same conversation, each with a load of its own.
  const threads = (/** @type {string} */ call, id = a) => page.evaluate(([fn, t]) => import('/app/js/open-threads.mjs').then((m) => m[fn](t)), [call, id]);
  await threads('openThread'); // opens A: its load is held
  await expect.poll(() => first).toBe(false);
  await threads('closeThread'); // closes A: warm
  for (const id of others) {
    await threads('openThread', id);
    await threads('closeThread', id);
  }
  // Three closed after it: A's items and range are let go.
  await expect.poll(() => page.evaluate((t) => import('/app/js/client.mjs').then(({ client }) => client.open.has(t)), a)).toBe(false);
  await settled(page);
  app.store.emit('item.add', { threadId: a, item: { id: 'it_away', kind: 'message', handle: 'you', text: 'while away', at: 9 } });
  await threads('openThread'); // opens A again: this load answers at once
  await expect.poll(() => held(page, a)).toContain('it_away');
  release();
  // The earlier opening's answer has reached the page, and the page has had its frames to place it.
  await expect.poll(() => landed).toBe(true);
  await settled(page);
  expect(await held(page, a), 'the message added while A was closed is still held').toContain('it_away');
});
