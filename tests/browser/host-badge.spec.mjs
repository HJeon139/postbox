// A host as a short badge in the agents list (shared/host-badge.mjs, app/js/agent-host.mjs hostBadge): a long SSH
// destination doesn’t fill the row. The badge is the start of the machine’s name until the person gives the host a
// short name in its settings; the connection shows in words beside it only when it isn’t Connected; and the whole line
// stays in the badge’s tooltip and in what a screen reader hears.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { axe, startRemote } from './remote-hosts.mjs';

const DEST = 'me@buildfarm-west-2.corp.example.com';
const MIN = 60_000;

/** @type {Awaited<ReturnType<typeof startRemote>>} */
let started;
let host;
let conv;

test.beforeAll(async () => {
  started = await startRemote('host-badge');
  const { rt, store } = started.app;
  host = rt.addHost({ name: DEST });
  started.hosts.set(host.id, { state: 'connected', failure: null, welcome: null, lastHeard: Date.now() - 2 * MIN, name: host.name });
  store.emit('project', { id: 'pr_badge', name: 'Badge', folder: started.app.root });
  const persona = rt.createPersona({ handle: 'builder', backend: 'claude-code', remote: { hostId: host.id } });
  conv = rt.createThread({ projectId: 'pr_badge', title: 'Badge', personaIds: [persona.id] });
});
test.afterAll(async () => {
  await started?.app.stop();
});
failOnPageErrors(test);

const row = (page) => page.locator('.rail .agent-row').filter({ hasText: 'builder' });
const badge = (page) => row(page).locator('.host-badge');

test('the row shows a short badge for the host, with the whole line in its tooltip and for a screen reader', async ({ page }) => {
  await page.goto(`${started.app.origin}/#/t/${conv.id}`);
  await synced(page, started.app);
  await expect(badge(page)).toHaveText('buildfar');
  await expect(badge(page)).toHaveAttribute('title', `On ${DEST} · Connected · last heard from 2 min ago`);
  await expect(row(page).locator('.host-line .sr-only')).toHaveText(`On ${DEST} · Connected · last heard from 2 min ago`);
  await expect(row(page).locator('.host-state'), 'Connected needs no words').toHaveCount(0);
  const box = await badge(page).boundingBox();
  expect(box?.width ?? 0, 'the badge stays compact').toBeLessThan(90);
  expect(await axe(page)).toEqual([]);

  started.hosts.set(host.id, { state: 'reconnecting', failure: null, welcome: null, lastHeard: Date.now() - 2 * MIN, name: host.name });
  await synced(page, started.app);
  await expect(row(page).locator('.host-state'), 'a connection that isn’t Connected says so').toHaveText(' Reconnecting');
  started.hosts.set(host.id, { state: 'connected', failure: null, welcome: null, lastHeard: Date.now() - 2 * MIN, name: host.name });
});

test('a short name set in the host’s settings becomes its badge, and clearing it goes back to the start of its name', async ({ page }) => {
  await page.goto(`${started.app.origin}/#/t/${conv.id}`);
  await synced(page, started.app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  await page.locator(`#ho-${host.id}-edit`).click();
  const field = page.getByLabel('Short name');
  await expect(field, 'empty, it shows the badge it would use').toHaveAttribute('placeholder', 'buildfar');
  await field.fill('gpu box');
  await page.locator(`#ho-${host.id}-save`).click();
  await expect.poll(() => started.app.store.state.hosts[host.id].short).toBe('gpu box');
  await page.keyboard.press('Escape');
  await synced(page, started.app);
  await expect(badge(page)).toHaveText('gpu box');

  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  await page.locator(`#ho-${host.id}-edit`).click();
  await page.getByLabel('Short name').fill('much too long');
  await page.locator(`#ho-${host.id}-save`).click();
  await expect(page.locator(`#ho-${host.id}-short-err`), 'a name past 8 characters is refused, under its field').toHaveText(/the most is 8/);
  await page.getByLabel('Short name').fill('');
  await page.locator(`#ho-${host.id}-save`).click();
  await expect.poll(() => 'short' in started.app.store.state.hosts[host.id]).toBe(false);
  await page.keyboard.press('Escape');
  await synced(page, started.app);
  await expect(badge(page)).toHaveText('buildfar');
});

test('#1052 Save with nothing changed keeps a short name stored before the check refused it, with no error', async ({ page }) => {
  // As an earlier Postbox kept it: an emoji with VS16, which a short name now refuses.
  started.app.store.emit('host', { ...started.app.store.state.hosts[host.id], short: '🖥️' });
  await page.goto(`${started.app.origin}/#/t/${conv.id}`);
  await synced(page, started.app);
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  await page.locator(`#ho-${host.id}-edit`).click();
  await expect(page.getByLabel('Short name')).toHaveValue('🖥️');
  await page.locator(`#ho-${host.id}-save`).click();
  await expect(page.getByText(`Saved ${DEST}`), 'it saves').toBeVisible();
  await expect(page.locator(`#ho-${host.id}-save`), 'and the editor closes').toHaveCount(0);
  expect(started.app.store.state.hosts[host.id].short, 'the name is kept').toBe('🖥️');
  const { short: _old, ...rest } = started.app.store.state.hosts[host.id];
  started.app.store.emit('host', rest);
});

// Last, since it takes the host away.
test('an agent whose host was removed shows “removed”, not a cut of the words that stand for it', async ({ page }) => {
  await page.goto(`${started.app.origin}/#/t/${conv.id}`);
  await synced(page, started.app);
  started.app.store.emit('host', { id: host.id, removed: true });
  await synced(page, started.app);
  await expect(badge(page)).toHaveText('removed');
});
