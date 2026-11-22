// The browser specs’ wait for the page to catch up (synced, tests/browser/postbox.mjs; #1532): a page whose stream
// stops still fails it, with its own message, now that its default bound is 20 s.

import { setTimeout as pace } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('synced');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const projectId = () => Object.keys(app.store.state.projects)[0];

test('synced fails, with its message, for a page whose stream stopped', async ({ page }) => {
  // Every stream the page opens is held: nothing it sends reaches the page, and only the state it loads does.
  await page.route('**/api/stream**', () => {});
  // The state comes 300 ms late, as it can under load, so a spec that didn’t wait for it would make its next event
  // before the page loads, and the state would bring that event’s seq without the stream (the integrator’s review of
  // #1540). This shapes what the page is sent, as live-cost.spec.mjs paces its events; nothing waits on the clock.
  await page.route('**/api/state**', async (route) => {
    await pace(300);
    await route.continue();
  });
  const t = app.rt.createThread({ projectId: projectId(), title: 'Held stream', personaIds: [] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  // The page has loaded its state, so the next event can reach it only over the stream.
  await synced(page, app);
  const loaded = app.store.state.seq;
  app.rt.createThread({ projectId: projectId(), title: 'After it', personaIds: [] });
  const error = await synced(page, app, 2_000).then(
    () => null,
    (e) => e,
  );
  // It ran out waiting, not on an error from the page: the page still held the seq it loaded. Not how long it took,
  // since Playwright’s poll stops one interval short of its deadline (pollAgainstDeadline), about 1 s into 2 s under load.
  const words = stripVTControlCharacters(String(error?.message));
  expect(words).toContain(`the page to hear event ${app.store.state.seq}`);
  expect(words).toMatch(new RegExp(`Received: +${loaded}\\b`));
});
