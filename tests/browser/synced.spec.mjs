// The browser specs’ wait for the page to catch up (synced, tests/browser/postbox.mjs; #1532): it waits for words a
// running turn still holds in their window before it takes the store’s seq, and its bound is 15 s, which a page whose
// stream stops still meets as a failure. 577 calls in the specs rely on both.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('synced');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const projectId = () => Object.keys(app.store.state.projects)[0];

test('synced doesn’t return while a running turn still holds words, which aren’t in the store yet', async ({ page }) => {
  const t = app.rt.createThread({ projectId: projectId(), title: 'Held words', personaIds: [arrange.persona(app.rt, 'librarian').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // A turn holding its words, as server/live-text.mjs holds them for their window.
  const running = app.rt.running;
  const all = running.all.bind(running);
  let held = true;
  running.all = () => (held ? [...all(), { liveText: { itemId: 'it_held', text: 'Not stored yet.' } }] : all());
  try {
    let done = false;
    const waiting = synced(page, app).then(() => {
      done = true;
    });
    // A later event, which the page hears while the words are still held: synced has had every chance to return.
    app.rt.createThread({ projectId: projectId(), title: 'Meanwhile', personaIds: [] });
    const later = app.store.state.seq;
    await expect
      .poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq)), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(later);
    expect(done, 'still waiting while the words are held').toBe(false);
    held = false;
    await waiting;
    expect(done).toBe(true);
  } finally {
    running.all = all;
  }
});

test('synced fails at its 15 s bound for a page whose stream stopped, not sooner and not much later', async ({ page }) => {
  test.setTimeout(60_000);
  // Every stream the page opens is held: nothing it sends reaches the page.
  await page.route('**/api/stream**', () => {});
  const t = app.rt.createThread({ projectId: projectId(), title: 'Held stream', personaIds: [] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  app.rt.createThread({ projectId: projectId(), title: 'After it', personaIds: [] });
  const started = Date.now();
  await expect(synced(page, app)).rejects.toThrow(/the page to hear event/);
  const took = Date.now() - started;
  // expect.poll gives up a poll interval short of its 15 s: about 14 s. 12 s still tells it from the 5 s it was.
  expect(took, 'the bound is 15 s').toBeGreaterThanOrEqual(12_000);
  expect(took, 'and it fails then').toBeLessThan(20_000);
});
