// The page’s place in history is its seq within the store’s history epoch (#508’s PR 1a; tests/store-epoch.test.mjs).
// /api/state gives the page the epoch, and the page names it when its stream connects, so a stream from another history
// (a page from before a restart, whatever its seq) is told to resync and loads the state again, rather than keeping what
// the store no longer holds. The second test puts a page on another epoch by rewriting its stream request’s epoch once,
// as a page from before a restart would send it.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('stream-epoch', { demo: false });
  app.store.emit('project', { id: 'pr_epoch', name: 'Epoch', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** The page’s client: its seq and the epoch it names. @param {import('@playwright/test').Page} page */
const clientOf = (page) => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => ({ seq: client.seq, epoch: client.epoch })));
/** The epoch a stream request names. @param {string} url */
const epochOf = (url) => new URL(url).searchParams.get('epoch');

/** A conversation with one agent of its own. @param {string} handle @param {string} title */
function conversation(handle, title) {
  const p = app.rt.createPersona({ handle });
  return app.rt.createThread({ projectId: 'pr_epoch', title, personaIds: [p.id] });
}

test('the page names the epoch /api/state gave it when its stream connects', async ({ page }) => {
  const t = conversation('reader', 'Named');
  const stream = page.waitForRequest((r) => r.url().includes('/api/stream'));
  await page.goto(`${app.origin}/#/t/${t.id}`);
  expect(epochOf((await stream).url())).toBe(app.store.epoch);
  await synced(page, app);
  expect((await clientOf(page)).epoch).toBe(app.store.epoch);
});

test('a page whose stream names another epoch is told to resync, loads the state again and goes on with the store’s epoch', async ({ page }) => {
  const t = conversation('writer', 'Resynced');
  app.rt.addItem(t.id, { kind: 'user', text: 'A message the store keeps' });
  // The page’s first stream request names an epoch from another history, as a page back from before a restart does.
  let rewritten = 0;
  await page.route('**/api/stream*', (route) => {
    if (rewritten++) return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('epoch', 'ep_before_the_restart');
    return route.continue({ url: url.href });
  });
  let loads = 0;
  page.on('request', (r) => r.url().includes('/api/state') && loads++);
  const again = page.waitForRequest((r) => r.url().includes('/api/stream') && epochOf(r.url()) === app.store.epoch);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect.poll(() => loads, { message: 'the page, told to resync, to load the state a second time' }).toBe(2);
  await again; // and connects naming the epoch that state came with
  await synced(page, app);
  await expect(page.getByText('A message the store keeps')).toBeVisible();
  expect((await clientOf(page)).epoch).toBe(app.store.epoch);
  // And it hears what comes next.
  app.rt.addItem(t.id, { kind: 'user', text: 'A message after the resync' });
  await expect(page.getByText('A message after the resync')).toBeVisible();
});
