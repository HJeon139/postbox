// A check overtaken before it ends: a new version, or the app retired, while its old version is in the hidden frames.
// The server ignores a result for a version that isn’t current, or for a retired app (server/apps.mjs, appCheck), so the
// page drops that check and starts the current version’s at once. Waiting it out had a new version wait about 4.6 s,
// twice the 2.3 s one check takes, and failed follow.spec on CI.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const PLAIN = (v) => `<main style="padding:12px;color:var(--text)"><h2>Corpus summary ${v}</h2><p>Twelve books.</p></main>`;
/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drawer;

test.beforeAll(async () => {
  app = await startPostbox('app-check-overtaken');
  app.rt.adapters.register({ name: 'mock', async deliver() {} });
  drawer = app.rt.createPersona({ handle: 'drawer' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation open on the page, its agent’s tools, and every check result the page posts, as `${appId}:${version}`. */
async function room(page, title) {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title, personaIds: [drawer.id] });
  const posted = [];
  page.on('request', (r) => {
    const m = r.method() === 'POST' && new URL(r.url()).pathname.match(/^\/api\/apps\/([^/]+)\/check$/);
    if (m) posted.push(`${decodeURIComponent(m[1])}:${r.postDataJSON()?.version}`);
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  return { rt, tools: rt.toolsFor(rt.sessionsIn(thread.id)[0].id), posted };
}

test('a new version during the old one’s check is checked at once, and the old one posts nothing', async ({ page }) => {
  const { rt, tools, posted } = await room(page, 'Overtaken by v2');
  tools.show_app({ id: 'overtaken', title: 'Overtaken', code: PLAIN('v1') });
  await expect(page.locator('iframe.check-frame[title="Checking Overtaken"]'), 'v1’s check is running').toHaveCount(2);
  const t0 = Date.now();
  tools.update_app({ id: 'overtaken', code: PLAIN('v2') });
  await expect.poll(() => rt.s.apps.overtaken.check.status, { intervals: [50], timeout: 15_000 }).toBe('passed');
  const took = Date.now() - t0;
  // One check takes about 2.3 s (600 ms, 800 ms of a still layout, then 900 ms between text measures); waiting behind
  // v1’s first took about 4.6 s. 3.5 s sits between them, with room for the 300 ms lag CI adds and a loaded runner.
  expect.soft(took, `v2 passed ${took} ms after it was made`).toBeLessThan(3_500);
  expect.soft(posted, 'only v2’s result was posted').toEqual(['overtaken:2']);
});

test('an app retired during its check posts nothing, and the next app’s check starts', async ({ page }) => {
  const { rt, tools, posted } = await room(page, 'Retired mid-check');
  tools.show_app({ id: 'retiring', title: 'Retiring', code: PLAIN('v1') });
  await expect(page.locator('iframe.check-frame[title="Checking Retiring"]'), 'its check is running').toHaveCount(2);
  expect(tools.retire_app({ id: 'retiring', reason: 'Another app covers it.' }).ok).toBe(true);
  await expect(page.locator('iframe.check-frame[title="Checking Retiring"]'), 'its check frames are gone').toHaveCount(0);
  tools.show_app({ id: 'after-retired', title: 'After retired', code: PLAIN('v1') });
  await expect.poll(() => rt.s.apps['after-retired'].check.status, { timeout: 15_000 }).toBe('passed');
  expect(posted, 'only the next app’s result was posted').toEqual(['after-retired:1']);
});

test('a version checked again after a drop is checked, not skipped', async ({ page }) => {
  // The dropped check’s key must not count as checked or failed: retiring v1 mid-check, then a new version, gets checked.
  const { rt, tools } = await room(page, 'Back after retiring');
  tools.show_app({ id: 'returns', title: 'Returns', code: PLAIN('v1') });
  await expect(page.locator('iframe.check-frame[title="Checking Returns"]')).toHaveCount(2);
  tools.retire_app({ id: 'returns', reason: 'For now.' });
  await expect(page.locator('iframe.check-frame[title="Checking Returns"]')).toHaveCount(0);
  tools.update_app({ id: 'returns', code: PLAIN('v2') });
  await expect.poll(() => rt.s.apps.returns.check.status, { timeout: 15_000 }).toBe('passed');
});
