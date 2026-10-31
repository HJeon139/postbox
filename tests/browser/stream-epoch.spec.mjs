// The page’s place in history is its seq within the store’s history epoch (server/live-streams.mjs; the integrator’s
// re-review of #553, blocker 3; #567). /api/state gives the page the epoch, and the page names it when its stream
// connects, so a stream from before a readback of Redis (a restart’s load, a repair’s reload) is told to resync whatever
// its seq, and loads the state again, rather than keeping what the store no longer holds.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

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

test('#567: a page back at the same seq after the store read Redis back is told to resync, and shows what the store holds', async ({ page }) => {
  const t = conversation('writer', 'Reloaded');
  app.rt.addItem(t.id, { kind: 'user', text: 'A message the store keeps' });
  app.rt.addItem(t.id, { kind: 'user', text: 'A message Redis refused' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.getByText('A message Redis refused')).toBeVisible();
  const before = app.store.epoch;
  const seq = app.store.state.seq;
  // The page goes into the back/forward cache: its stream closes, as on pagehide, so it won’t hear the reload.
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  // Meanwhile Retry’s repair reads Redis back without the refused change (server/store-reject.mjs): a new epoch, the
  // seq where it was. The page would otherwise reconnect at that seq and be told nothing.
  await app.store.flush();
  const state = structuredClone(app.store.state);
  state.items[t.id] = state.items[t.id].filter((it) => it.text !== 'A message Redis refused');
  await app.store.reloaded(state, app.store.positions);
  expect(app.store.epoch).not.toBe(before);
  expect(app.store.state.seq).toBe(seq);
  const back = page.waitForRequest((r) => r.url().includes('/api/stream') && epochOf(r.url()) === before);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await back; // the page came back naming the old epoch, at the seq it had
  await expect(page.getByText('A message Redis refused')).toBeHidden();
  await expect(page.getByText('A message the store keeps')).toBeVisible();
  await expect.poll(() => clientOf(page).then((c) => c.epoch), { message: 'the page to take the new epoch' }).toBe(app.store.epoch);
  // And it hears what comes next on the new epoch.
  app.rt.addItem(t.id, { kind: 'user', text: 'A message after the reload' });
  await expect(page.getByText('A message after the reload')).toBeVisible();
});

// gpt’s r10 review of #553, blocker 2: the page took the epoch from the stream’s first frame at once. When the load the
// resync asked for then failed, the page held the new epoch with the old state, and its next reconnect, at the same seq,
// was accepted as synchronized: the old history stayed on the page for good. The page’s epoch is only ever the one that
// came with a state it loaded; until a load succeeds it names its old epoch, and the server resyncs it again.
test('a page whose load after a resync failed keeps naming its old epoch, so its next reconnect is resynced, not accepted', async ({ page }) => {
  const t = conversation('loader', 'Failed load');
  app.rt.addItem(t.id, { kind: 'user', text: 'A message the store keeps' });
  app.rt.addItem(t.id, { kind: 'user', text: 'A message Redis refused' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.getByText('A message Redis refused')).toBeVisible();
  const before = app.store.epoch;
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await app.store.flush();
  const state = structuredClone(app.store.state);
  state.items[t.id] = state.items[t.id].filter((it) => it.text !== 'A message Redis refused');
  await app.store.reloaded(state, app.store.positions);
  expect(app.store.epoch).not.toBe(before);
  // The page comes back naming the old epoch: the stream’s first frame names the new one and says resync, but the load
  // of the state fails this once (the server was busy, say).
  let failed = 0;
  allowPageError(page, /503/);
  await page.route('**/api/state', (route) => (failed++ ? route.continue() : route.fulfill({ status: 503, body: 'busy' })));
  const back = page.waitForRequest((r) => r.url().includes('/api/stream'));
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(epochOf((await back).url())).toBe(before);
  await expect.poll(() => failed, { message: 'the load to be tried and fail' }).toBe(1);
  // Away and back again: the page still shows the old history, so it must still name the old epoch.
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  const again = page.waitForRequest((r) => r.url().includes('/api/stream'));
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(epochOf((await again).url()), 'a page still showing the old history names the epoch that history came with').toBe(before);
  await expect(page.getByText('A message Redis refused')).toBeHidden();
  await expect(page.getByText('A message the store keeps')).toBeVisible();
  await expect.poll(() => clientOf(page).then((c) => c.epoch), { message: 'the page to take the new epoch with the state it loaded' }).toBe(app.store.epoch);
});
