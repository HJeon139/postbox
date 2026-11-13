// A turn that waits on a host while Postbox installs its version there by itself (#464-b2b; designs/architecture/remote-hosts.md, “Keeping a host up to date”):
// the turn’s status line in the agents list and the agent’s panel says “Installing Postbox
// <version> on <host>…”, never a token or a path, and goes once the install has ended. An idle agent on that host
// says nothing of it. At 1280 px, with axe; at 375 px a phone has no agents list, so only that nothing shows a token
// or a path. With the fake host manager of tests/browser/remote-hosts.mjs.

import { expect, test } from '@playwright/test';
import { failure } from '../../server/remote/ssh.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, PHONE, synced } from './postbox.mjs';
import { axe, overflowing, startRemote } from './remote-hosts.mjs';

/** @type {Awaited<ReturnType<typeof startRemote>>} */
let s;
/** @type {{ host: any, waiting: any, idle: any, room: any }} */
let at;
test.beforeAll(async () => {
  s = await startRemote('remote-installing');
  const { rt, store } = s.app;
  store.emit('project', { id: 'pr_install', name: 'Install', folder: s.app.root });
  const host = rt.addHost({ name: 'host.example.com' });
  const waiting = rt.createPersona({ handle: 'waiter', backend: 'claude-code', remote: { hostId: host.id } });
  const idle = rt.createPersona({ handle: 'idler', backend: 'claude-code', remote: { hostId: host.id } });
  const room = rt.createThread({ projectId: 'pr_install', title: 'Installing', personaIds: [waiting.id, idle.id] });
  at = { host, waiting, idle, room };
});
test.afterAll(async () => {
  await s?.app.stop();
});
failOnPageErrors(test);

const VERSION = '0.18.0';
const TOKEN = 'T'.repeat(43);
const LINE = `Installing Postbox ${VERSION} on host.example.com…`;
const MISSING = (() => {
  const f = failure('not-installed', 'host.example.com', { code: 127 });
  return { kind: f.kind, message: f.message, next: f.next, retry: false };
})();
/** The host’s status with its newest automatic install; a token and a path ride along, which the page must never show. */
const withUpdate = (state, outcome) => ({
  state,
  failure: state === 'connected' ? null : MISSING,
  welcome: null,
  lastHeard: Date.now(),
  name: 'host.example.com',
  keepUpdated: true,
  update: { version: VERSION, at: Date.now(), outcome, token: TOKEN, path: '/home/user/.postbox-remote' },
});
const sessionOf = (persona) => arrange.sessionsIn(s.app.rt, at.room.id).find((se) => se.personaId === persona.id);
/** An agent’s row in the sidebar’s Agents. */
const row = (page, handle) => page.locator('.rail .agent-row').filter({ has: page.locator('.agent-btn b', { hasText: new RegExp(`^${handle}$`) }) });

/** Opens the room with @waiter at work, its turn waiting on the host. @param {import('@playwright/test').Page} page */
async function open(page) {
  s.hosts.set(at.host.id, withUpdate('failed', 'started'));
  arrange.setSession(s.app.rt, sessionOf(at.waiting).id, { state: 'think', currentStep: 'Thinking' });
  arrange.setSession(s.app.rt, sessionOf(at.idle).id, { state: 'idle' });
  await page.goto(`${s.app.origin}/#/t/${at.room.id}`);
  await synced(page, s.app);
}

const story = async (page) => {
  await open(page);
  await expect(row(page, 'waiter'), 'the agents list').toBeVisible();
  await test.step('while the install runs', async () => {
    await expect(row(page, 'waiter').locator('.host-turn'), 'the waiting turn’s status line').toHaveText(LINE);
    await expect.soft(row(page, 'idler').locator('.host-turn'), 'an idle agent on that host says nothing of it').toHaveCount(0);
    const text = (await page.locator('.rail').textContent()) ?? '';
    expect.soft(text, 'no token').not.toContain(TOKEN);
    expect.soft(text, 'no path on the host').not.toContain('/home/');
    expect.soft(await overflowing(page, '.agent-row .host-turn'), 'it fits the window').toEqual([]);
    expect.soft(await axe(page), 'axe').toEqual([]);
  });
  await test.step('once it installed', async () => {
    s.hosts.set(at.host.id, withUpdate('connected', 'installed'));
    await expect(row(page, 'waiter'), 'the line goes').not.toContainText('Installing Postbox');
  });
  await test.step('once it failed', async () => {
    s.hosts.set(at.host.id, withUpdate('failed', 'started'));
    await expect(row(page, 'waiter').locator('.host-turn')).toHaveText(LINE);
    s.hosts.set(at.host.id, withUpdate('failed', 'failed'));
    await expect(row(page, 'waiter'), 'the line goes').not.toContainText('Installing Postbox');
  });
};

test('#464 a turn waiting on a host while Postbox installs there says so, at 1280 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await story(page);
});

/**
 * A phone has no sidebar, so no agents list and no agent’s panel: the turn’s status line isn’t shown there, as a
 * turn’s other host lines aren’t (app/workbench.css, “Phone”). What the page does show holds no token or path.
 * @param {import('@playwright/test').Page} page
 */
const phone = async (page) => {
  await open(page);
  await expect(page.locator('.rail'), 'a phone has no sidebar').toBeHidden();
  const text = (await page.locator('body').textContent()) ?? '';
  expect.soft(text, 'no token').not.toContain(TOKEN);
  expect.soft(text, 'no path on the host').not.toContain('/home/');
  expect.soft(await overflowing(page, '.transcript, .composer'), 'the room fits the window').toEqual([]);
  expect.soft(await axe(page), 'axe').toEqual([]);
};

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, ...PHONE });
  test('#464 at 375 px a turn waiting on a host while Postbox installs there shows no token or path', ({ page }) => phone(page));
});
