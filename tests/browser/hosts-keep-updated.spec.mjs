// Keeping a host’s Postbox up to date (#464-b2b; designs/464-keep-updated.md, “What b2b adds”), in the Hosts tab of
// Settings: the toggle in the host’s editor, which saves at once through PUT /api/hosts/:id/keep-updated and goes back
// with the server’s message when that fails, and follows the host’s status; and the card’s line for its newest
// automatic install: installing, installed by itself, or failed with Install… beside it, never a token or a path,
// and nothing for busy or present. Each is checked at 1280 and 375 px, with axe. With a fake host manager
// (tests/browser/hosts.mjs), so nothing connects to a host.

import { expect, test } from '@playwright/test';
import { failure } from '../../server/remote/ssh.mjs';
import { audit, card, freshHost, openHosts, SIZES, startHosts, VERSION } from './hosts.mjs';
import { allowPageError, failOnPageErrors } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startHosts>>['app']} */
let app;
/** @type {Awaited<ReturnType<typeof startHosts>>['fake']} */
let fake;
test.beforeAll(async () => {
  ({ app, fake } = await startHosts('hosts-keep-updated'));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const NAME = 'build.example.com';
const TOGGLE = 'Keep Postbox up to date on this host';
const HELP = 'Install this Postbox’s version here when it’s missing, once per version.';
/** A daemon token and a path on the host, put where a careless status would pass them on; the card must never show them. */
const TOKEN = 'T'.repeat(43);
const PATH = '/home/user/.postbox-remote/versions/0.18.0';
/** The launcher’s 127, as the link reports it: this Postbox’s version isn’t on the host. */
const MISSING = (() => {
  const f = failure('not-installed', NAME, { code: 127 });
  return { kind: f.kind, message: f.message, next: f.next, retry: false };
})();
const keepCalls = () => fake.calls.filter((c) => c[0] === 'setKeepUpdated');
/** The host’s status with its newest automatic install. @param {string} state @param {any} update */
const withUpdate = (state, update) => ({
  state,
  failure: state === 'connected' ? null : MISSING,
  keepUpdated: true,
  update: { version: VERSION, at: Date.now(), token: TOKEN, path: PATH, ...update },
});

/** Opens the host’s editor and returns the toggle. @param {import('@playwright/test').Page} page */
async function openToggle(page) {
  const c = card(page, NAME);
  await c.getByRole('button', { name: `Edit settings for ${NAME}` }).click();
  return c.getByRole('checkbox', { name: TOGGLE });
}

/** @param {import('@playwright/test').Page} page */
async function toggle(page) {
  const id = freshHost(app, fake, NAME);
  fake.set(id, { state: 'disconnected', keepUpdated: false });
  await openHosts(page, app);
  const box = await openToggle(page);
  await expect(box, 'the toggle starts as the host’s status has it, off').toHaveAttribute('aria-checked', 'false');
  await expect.soft(box, 'with its help').toHaveAccessibleDescription(HELP);
  await audit(page, 'the editor with the toggle');

  await box.click();
  await expect.poll(keepCalls, { message: 'turning it on saves at once, with { on: true }' }).toEqual([['setKeepUpdated', id, true]]);
  await expect.soft(box, 'and it shows on').toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => app.store.state.hostStatus[id]?.keepUpdated, { message: 'the host’s status says so' }).toBe(true);

  await box.press(' ');
  await expect.poll(keepCalls, { message: 'turning it off by keyboard saves { on: false }' }).toEqual([
    ['setKeepUpdated', id, true],
    ['setKeepUpdated', id, false],
  ]);
  await expect.soft(box, 'and it shows off').toHaveAttribute('aria-checked', 'false');

  const on = freshHost(app, fake, NAME);
  fake.set(on, { state: 'disconnected', keepUpdated: true });
  await openHosts(page, app);
  await expect.soft(await openToggle(page), 'a host whose consent is on opens with the toggle on').toHaveAttribute('aria-checked', 'true');
}

/** @param {import('@playwright/test').Page} page */
async function refused(page) {
  const id = freshHost(app, fake, NAME);
  fake.set(id, { state: 'disconnected', keepUpdated: false });
  await openHosts(page, app);
  const box = await openToggle(page);
  fake.keepUpdatedError = new Error('EACCES: permission denied');
  allowPageError(page, /status of 500/);
  await box.click();
  await expect.poll(keepCalls, { message: 'it asked the server' }).toEqual([['setKeepUpdated', id, true]]);
  await expect(box, 'a failed save goes back to off').toHaveAttribute('aria-checked', 'false');
  await expect
    .soft(box, 'and says what happened under the toggle, as the editor’s other errors do')
    .toHaveAccessibleErrorMessage('Something went wrong on the server. Try again; if it keeps happening, check the server log.');
  await expect.soft(box, 'marked invalid').toHaveAttribute('aria-invalid', 'true');
  expect.soft(app.store.state.hostStatus[id]?.keepUpdated, 'and nothing was saved').toBe(false);
  await audit(page, 'a refused toggle');

  app.store.emit('host', { ...app.store.state.hosts[id] });
  await expect.soft(box, 'a repaint of the tab keeps the error').toHaveAccessibleErrorMessage(/^Something went wrong on the server/);
  await expect.soft(box, 'still marked invalid').toHaveAttribute('aria-invalid', 'true');

  fake.keepUpdatedError = null;
  await box.click();
  await expect.poll(keepCalls, { message: 'the next click asks for on again, not off' }).toEqual([
    ['setKeepUpdated', id, true],
    ['setKeepUpdated', id, true],
  ]);
  await expect.soft(box, 'it shows on').toHaveAttribute('aria-checked', 'true');
  await expect.soft(box, 'and the error goes').not.toHaveAttribute('aria-invalid', 'true');

  fake.set(id, { state: 'disconnected', keepUpdated: false });
  await expect.soft(box, 'a change to the status elsewhere moves the open toggle').toHaveAttribute('aria-checked', 'false');
}

/** What a step’s card says must never hold a token or a path. @param {import('@playwright/test').Locator} c */
async function noSecrets(c) {
  const text = (await c.textContent()) ?? '';
  expect.soft(text, 'no token').not.toContain(TOKEN);
  expect.soft(text, 'no path on the host').not.toContain('/home/');
  expect.soft(text, 'nor Postbox’s folder there').not.toContain('.postbox-remote');
}

/** @param {import('@playwright/test').Page} page */
async function cardStates(page) {
  const id = freshHost(app, fake, NAME);
  await openHosts(page, app);
  const c = card(page, NAME);
  const line = c.locator('.ho-update');

  await test.step('installing', async () => {
    fake.set(id, withUpdate('failed', { outcome: 'started' }));
    await expect(line, 'an install under way').toHaveText(`Installing Postbox ${VERSION}…`);
    await noSecrets(c);
    await audit(page, 'installing');
  });

  await test.step('installed by itself', async () => {
    fake.set(id, withUpdate('connected', { outcome: 'installed' }));
    await expect(line, 'once it installed').toHaveText(`Postbox installed ${VERSION} here by itself`);
    await noSecrets(c);
    await audit(page, 'installed by itself');
  });

  await test.step('failed, with Install… beside it', async () => {
    fake.set(id, withUpdate('failed', { outcome: 'failed' }));
    await expect(line, 'a failed install').toContainText(`Postbox couldn’t install ${VERSION} here by itself.`);
    await expect.soft(line.getByRole('button', { name: 'Install…' }), 'with Install… beside it').toBeVisible();
    await expect.soft(c.getByRole('button', { name: 'Install…' }), 'and only one Install… on the card').toHaveCount(1);
    await noSecrets(c);
    await audit(page, 'a failed install');

    fake.set(id, { ...withUpdate('not-installed', { outcome: 'failed' }), failure: null });
    await expect.soft(line, 'a failed install on a host not installed yet').toContainText(`Postbox couldn’t install ${VERSION} here by itself.`);
    await expect.soft(c.getByRole('button', { name: 'Install…' }), 'still only one Install… on the card').toHaveCount(1);

    const why = 'Postbox couldn’t note the install in its data folder (EACCES), so it didn’t install by itself. Install it from here.';
    fake.set(id, withUpdate('failed', { outcome: 'started', error: why }));
    await expect.soft(line, 'a note it couldn’t write says why, not “Installing”').toContainText(why);
    await expect.soft(line.getByRole('button', { name: 'Install…' }), 'with Install… beside it').toBeVisible();
    await noSecrets(c);

    await line.getByRole('button', { name: 'Install…' }).click();
    await expect(page.getByRole('alertdialog', { name: `Install Postbox on ${NAME}?` }), 'Install… asks first, as ever').toBeVisible();
  });
}

/** @param {import('@playwright/test').Page} page */
async function quietStates(page) {
  const id = freshHost(app, fake, NAME);
  await openHosts(page, app);
  const c = card(page, NAME);
  fake.set(id, withUpdate('reconnecting', { outcome: 'busy' }));
  await expect(c.locator('.status-tag'), 'the status arrived').toHaveText('Reconnecting');
  await expect.soft(c.locator('.ho-update'), 'busy says nothing of its own').toHaveCount(0);
  fake.set(id, withUpdate('connected', { outcome: 'present' }));
  await expect(c.locator('.status-tag'), 'the status arrived').toHaveText('Connected');
  await expect.soft(c.locator('.ho-update'), 'present says nothing of its own').toHaveCount(0);
  fake.set(id, withUpdate('connected', { outcome: 'started' }));
  await expect.soft(c.locator('.ho-update'), 'an install under way says nothing once the host is connected').toHaveCount(0);
}

for (const { width, use } of SIZES)
  test.describe(`at ${width} px`, () => {
    test.use(use);
    test('#464 the toggle saves on and off at once, as the host’s status has it', ({ page }) => toggle(page));
    test('#464 a toggle the server refuses goes back, says why, and follows the status', ({ page }) => refused(page));
    test('#464 the card says installing, installed by itself, or failed with Install…, never a token or a path', ({ page }) => cardStates(page));
    test('#464 busy and present say nothing on the card', ({ page }) => quietStates(page));
  });
