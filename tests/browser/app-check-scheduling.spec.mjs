// Scheduling and persistence around the pre-display app check (#37, #336).

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

const PLAIN = `<main style="padding:12px;color:var(--text)"><h2>Corpus summary</h2><p>Twelve books.</p></main>`;
/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drawer;

test.beforeAll(async () => {
  app = await startPostbox('app-check-scheduling');
  app.rt.adapters.register({ name: 'mock', async deliver() {} });
  drawer = app.rt.createPersona({ handle: 'drawer' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

function room(title) {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title, personaIds: [drawer.id] });
  return { rt, store, thread, session: rt.sessionsIn(thread.id)[0] };
}

test('#336 an open page checks an app in a topic thread nobody opened', async ({ page }) => {
  const { rt, thread, session } = room('Unopened topic app');
  const root = rt.addItem(thread.id, {
    kind: 'agent',
    sessionId: session.id,
    personaId: session.personaId,
    handle: session.handle,
    text: 'The app belongs in a topic.',
    status: 'done',
  });
  const { threadId } = rt.startTopic(thread.id, root.id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  rt.toolsFor(session.id, /** @type {any} */ ({ threadId })).show_app({ id: 'unopened-topic', title: 'Unopened topic', code: PLAIN });
  await expect.poll(() => rt.s.apps['unopened-topic'].check.status, { timeout: 30_000 }).toBe('passed');
  await expect(page.locator('iframe[title="Unopened topic"]')).toHaveCount(0);
});

test('#37 an off-screen app pauses while the next app is checked', async ({ page }) => {
  const { rt, thread, session } = room('Off-screen app');
  const tools = rt.toolsFor(session.id);
  tools.show_app({ id: 'offscreen-app', title: 'Off-screen app', code: PLAIN });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.s.apps['offscreen-app'].check.status, { timeout: 30_000 }).toBe('passed');
  const offscreen = page.locator('iframe.app-iframe[title="Off-screen app"]');
  await expect(offscreen).toBeAttached();
  for (let i = 0; i < 20; i++)
    rt.addItem(thread.id, {
      kind: 'agent',
      sessionId: session.id,
      personaId: session.personaId,
      handle: session.handle,
      text: `Result ${i + 1}. ${'This keeps the earlier app outside the viewport while the next app is checked. '.repeat(3)}`,
      status: 'done',
    });
  await synced(page, app);
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await settled(page);
  tools.show_app({ id: 'after-offscreen', title: 'After off-screen', code: PLAIN });
  await expect(page.locator('iframe.check-frame[title="Checking After off-screen"]')).toHaveCount(2);
  await expect(offscreen).toHaveCount(0);
  await expect.poll(() => rt.s.apps['after-offscreen'].check.status, { timeout: 30_000 }).toBe('passed');
});

test('#37 a visible app keeps running through another conversation’s check without a click', async ({ page }) => {
  const visibleRoom = room('Visible counter');
  const otherRoom = room('Other counter check');
  visibleRoom.rt.toolsFor(visibleRoom.session.id).show_app({
    id: 'visible-counter',
    title: 'Visible counter',
    code: '<p id="counter">0</p><script>let n = 0; setInterval(() => { counter.textContent = String(++n); }, 50);</script>',
  });
  await page.goto(`${app.origin}/#/t/${visibleRoom.thread.id}`);
  await synced(page, app);
  await expect.poll(() => visibleRoom.rt.s.apps['visible-counter'].check.status, { timeout: 30_000 }).toBe('passed');
  const iframe = page.locator('iframe.app-iframe[title="Visible counter"]');
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!handle || !frame) throw new Error('The visible counter has no frame to test.');
  const counter = frame.locator('#counter');
  await expect.poll(async () => Number(await counter.textContent())).toBeGreaterThan(0);
  const before = Number(await counter.textContent());
  await page.mouse.move(1, 1);

  otherRoom.rt.toolsFor(otherRoom.session.id).show_app({ id: 'other-counter-app', title: 'Other counter app', code: PLAIN });
  await expect(page.locator('iframe.check-frame[title="Checking Other counter app"]')).toHaveCount(2);
  expect(await handle.evaluate((node) => node.isConnected), 'the same visible frame stays mounted').toBe(true);
  await expect.poll(async () => Number(await counter.textContent())).toBeGreaterThan(before);
  await expect.poll(() => otherRoom.rt.s.apps['other-counter-app'].check.status, { timeout: 30_000 }).toBe('passed');
});

test('#37 a check leaves the app the person is using mounted', async ({ page }) => {
  const { rt, thread, session } = room('Active app stays mounted');
  const tools = rt.toolsFor(session.id);
  tools.show_app({ id: 'active-app', title: 'Active app', code: '<label>Draft <input id="draft"></label>' });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.s.apps['active-app'].check.status, { timeout: 30_000 }).toBe('passed');
  const active = page.locator('iframe.app-iframe[title="Active app"]');
  await page.locator('.app-body[data-app-id="active-app"]').hover();
  await active.contentFrame().locator('#draft').fill('unsaved words');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('title'))).toBe('Active app');
  tools.show_app({ id: 'checking-next', title: 'Checking next', code: PLAIN });
  await expect(page.locator('iframe.check-frame[title="Checking Checking next"]')).toHaveCount(2);
  await expect(active).toBeAttached();
  await expect(active.contentFrame().locator('#draft')).toHaveValue('unsaved words');
  await expect.poll(() => rt.s.apps['checking-next'].check.status, { timeout: 30_000 }).toBe('passed');
});

test('#37 an app the person used keeps unsaved state while another conversation checks an app', async ({ page }) => {
  const visibleRoom = room('Visible app');
  const otherRoom = room('Other conversation check');
  const visibleTools = visibleRoom.rt.toolsFor(visibleRoom.session.id);
  visibleTools.show_app({ id: 'visible-app', title: 'Visible app', code: '<label>Draft <input id="visible-draft"></label>' });
  await page.goto(`${app.origin}/#/t/${visibleRoom.thread.id}`);
  await synced(page, app);
  await expect.poll(() => visibleRoom.rt.s.apps['visible-app'].check.status, { timeout: 30_000 }).toBe('passed');
  const visible = page.locator('iframe.app-iframe[title="Visible app"]');
  await page.locator('.app-body[data-app-id="visible-app"]').hover();
  await visible.contentFrame().locator('#visible-draft').fill('keep this draft');
  await page.locator('#composer-input').click();
  await page.mouse.move(1, 1);

  otherRoom.rt.toolsFor(otherRoom.session.id).show_app({ id: 'other-app', title: 'Other app', code: PLAIN });
  await expect(page.locator('iframe.check-frame[title="Checking Other app"]')).toHaveCount(2);
  await expect(visible, 'the visible frame is not torn down').toBeAttached();
  await expect(visible.contentFrame().locator('#visible-draft')).toHaveValue('keep this draft');
  await expect.poll(() => otherRoom.rt.s.apps['other-app'].check.status, { timeout: 30_000 }).toBe('passed');
});

test('one tab queues one app-check lock request and waits without another store event', async ({ page }) => {
  const { rt, thread, session } = room('Lock queue');
  const tools = rt.toolsFor(session.id);
  tools.show_app({ id: 'lock-base', title: 'Lock base', code: PLAIN });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.s.apps['lock-base'].check.status, { timeout: 30_000 }).toBe('passed');
  const lockBase = page.locator('iframe.app-iframe[title="Lock base"]');
  await expect(lockBase).toBeAttached();
  for (let i = 0; i < 12; i++)
    rt.addItem(thread.id, {
      kind: 'agent',
      sessionId: session.id,
      personaId: session.personaId,
      handle: session.handle,
      text: `Lock result ${i + 1}. ${'This moves the app outside the viewport before the lock is held. '.repeat(3)}`,
      status: 'done',
    });
  await synced(page, app);
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  await settled(page);
  await expect(lockBase).toBeAttached();
  expect(await lockBase.evaluate((frame) => frame.getBoundingClientRect().bottom <= 0), 'the base app is outside the viewport').toBe(true);
  let reloads = 0;
  page.on('request', (request) => {
    if (request.url().includes('/sandbox/app/lock-base/1')) reloads++;
  });
  await page.evaluate(() => {
    navigator.locks.request('postbox-app-check', () => {
      window.__appCheckLockHeld = true;
      return new Promise((resolve) => {
        window.__releaseAppCheckLock = resolve;
      });
    });
  });
  await expect.poll(() => page.evaluate(() => window.__appCheckLockHeld)).toBe(true);
  tools.show_app({ id: 'lock-queued', title: 'Lock queued', code: PLAIN });
  for (let i = 1; i <= 3; i++) rt.appState('lock-base', { update: i });
  await synced(page, app);
  await frames(page);
  expect(rt.s.apps['lock-queued'].check.status).toBe('pending');
  await page.evaluate(() => window.__releaseAppCheckLock());
  await expect.poll(() => rt.s.apps['lock-queued'].check.status, { timeout: 30_000 }).toBe('passed');
  await page.evaluate(() => navigator.locks.request('postbox-app-check', () => {}));
  expect(reloads, 'the paused app reloads once after the one queued request').toBe(1);
});

test('a hidden tab leaves a pending app for a visible tab to check', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  const { rt, thread, session } = room('Hidden tab');
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  rt.toolsFor(session.id).show_app({ id: 'hidden-tab-app', title: 'Hidden tab app', code: PLAIN });
  await synced(page, app);
  await frames(page);
  await expect(page.locator('iframe.check-frame[title="Checking Hidden tab app"]')).toHaveCount(0);
  expect(rt.s.apps['hidden-tab-app'].check.status).toBe('pending');

  const visiblePage = await page.context().newPage();
  try {
    await visiblePage.goto(`${app.origin}/#/t/${thread.id}`);
    await synced(visiblePage, app);
    await expect.poll(() => rt.s.apps['hidden-tab-app'].check.status, { timeout: 30_000 }).toBe('passed');
  } finally {
    await visiblePage.close();
  }
});

test('an app mounted during another check has a placeholder and loads once', async ({ page }) => {
  const checkingRoom = room('Check in progress');
  const readyRoom = room('Ready during check');
  await page.goto(`${app.origin}/#/t/${checkingRoom.thread.id}`);
  await synced(page, app);
  checkingRoom.rt.toolsFor(checkingRoom.session.id).show_app({ id: 'check-in-progress', title: 'Check in progress', code: PLAIN });
  await expect(page.locator('iframe.check-frame[title="Checking Check in progress"]')).toHaveCount(2);

  let loads = 0;
  page.on('request', (request) => {
    if (request.url().includes('/sandbox/app/ready-during-check/1')) loads++;
  });
  readyRoom.rt.toolsFor(readyRoom.session.id).show_app({ id: 'ready-during-check', title: 'Ready during check', code: PLAIN });
  readyRoom.rt.appCheck('ready-during-check', { version: 1, problems: [] });
  await page.goto(`${app.origin}/#/t/${readyRoom.thread.id}`);
  await synced(page, app);
  await expect(page.locator('.app-body[data-app-id="ready-during-check"]')).toContainText('Waiting for another app’s check to finish…');
  await expect(page.locator('iframe.app-iframe[title="Ready during check"]')).toBeAttached({ timeout: 30_000 });
  expect(loads).toBe(1);
});

test('a failed app-check save is tried again without rerunning the check', async ({ page }) => {
  allowPageError(page, /Failed to load resource: net::ERR_FAILED/);
  const { rt, thread, session } = room('Retry check save');
  let saves = 0;
  await page.route('**/api/apps/retry-save/check', async (route) => {
    saves++;
    if (saves === 1) await route.abort('failed');
    else await route.continue();
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  rt.toolsFor(session.id).show_app({ id: 'retry-save', title: 'Retry save', code: PLAIN });
  await expect.poll(() => rt.s.apps['retry-save'].check.status, { timeout: 30_000 }).toBe('passed');
  expect(saves).toBe(2);
});
