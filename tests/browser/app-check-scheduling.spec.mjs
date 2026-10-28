// Scheduling and persistence around the pre-display app check (#37, #336).

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

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

test('#37 a running CPU-heavy app cannot starve the next app check', async ({ page }) => {
  const { rt, thread, session } = room('CPU-heavy app');
  const tools = rt.toolsFor(session.id);
  tools.show_app({
    id: 'busy-app',
    title: 'Busy app',
    code: `<p>Busy</p><script>postbox.ready.then(() => { if (!postbox.check) while (true) {} });</script>`,
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.s.apps['busy-app'].check.status, { timeout: 30_000 }).toBe('passed');
  await expect(page.locator('iframe.app-iframe[title="Busy app"]')).toBeAttached();
  tools.show_app({ id: 'after-busy', title: 'After busy', code: PLAIN });
  await expect.poll(() => rt.s.apps['after-busy'].check.status, { timeout: 30_000 }).toBe('passed');
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
