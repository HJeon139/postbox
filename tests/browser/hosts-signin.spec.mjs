// A host’s harness that isn’t signed in shows before any turn starts there (#1608): on the host’s card in the Hosts
// tab, with the command to run there, and under “Runs on” when an agent is placed on that host. The host’s answer is
// hostStatus.signIns, in the shape server/remote/host-status.mjs’s signInFields publishes, set here through a fake host
// manager (tests/browser/remote-hosts.mjs) as the real one sets it after asking the host’s daemon (#1957).
import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { axe, startRemote } from './remote-hosts.mjs';
import { expectTidyText } from './text-layout.mjs';

/** @type {Awaited<ReturnType<typeof startRemote>>} */
let started;
test.beforeAll(async () => {
  started = await startRemote('host-signin');
});
test.afterAll(async () => {
  await started?.app.stop();
});
failOnPageErrors(test);

const found = (/** @type {string} */ name, /** @type {string} */ bin) => ({ name, path: `/home/user/.local/bin/${bin}`, version: '1.0.0', looked: [] });

/**
 * A connected host with Claude Code, Kiro and Codex found, and what it last said of each one’s sign-in.
 * @param {string} name @param {Record<string, string>} states  harness → 'signed-in' | 'signed-out' | 'unknown'
 */
function hostWith(name, states) {
  const host = started.app.rt.addHost({ name });
  started.hosts.set(host.id, {
    state: 'connected',
    failure: null,
    lastHeard: Date.now(),
    welcome: {
      version: '0.18.0',
      home: '/home/user',
      node: { version: '22.12.0', path: '/usr/bin/node' },
      harnesses: [found('claude-code', 'claude'), found('kiro-cli', 'kiro-cli'), found('codex', 'codex')],
      problems: [],
      turns: [],
    },
    signIns: { at: Date.now(), harnesses: Object.entries(states).map(([n, state]) => ({ name: n, state })) },
  });
  return host;
}

/** @param {import('@playwright/test').Page} page @param {(m: any) => any} open */
async function openSettings(page, open) {
  await page.goto(`${started.app.origin}/`);
  await synced(page, started.app);
  await page.evaluate(open);
  return page.getByRole('dialog');
}

test('#1608 a host’s card says which harness isn’t signed in there, with the command to run there', async ({ page }) => {
  const host = hostWith('gpu.example.com', { 'claude-code': 'signed-in', codex: 'signed-out', 'kiro-cli': 'unknown' });
  const settings = await openSettings(page, () => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  const card = settings.getByRole('region', { name: host.name, exact: true });
  const facts = card.getByLabel(`What Postbox found on ${host.name}`);
  await expect(facts.locator('dd').filter({ hasText: 'claude' })).toContainText('Signed in');
  const warned = card.locator('.ho-signin');
  await expect(warned, 'one warning: Codex alone is signed out, and an unknown warns of nothing').toHaveCount(1);
  await expect(warned).toContainText(`Codex isn’t signed in on ${host.name}`);
  await expect(facts.locator('dd').filter({ hasText: 'codex' })).toContainText('Not signed in');
  await expect(warned.locator('code')).toHaveText('codex login');
  await expect(facts.locator('dd').filter({ hasText: 'kiro-cli' })).not.toContainText('signed in', { ignoreCase: true });
  expect(await axe(page)).toEqual([]);
});

test('#1608 placing an agent on a host where its harness isn’t signed in says so under Runs on, with the command', async ({ page }) => {
  const host = hostWith('build.example.com', { codex: 'signed-out' });
  const persona = started.app.rt.createPersona({ handle: 'on-build', backend: 'codex', remote: { hostId: host.id } });
  const sheet = await openSettings(page, () => null);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  const where = sheet.locator('#pe-where');
  const warning = sheet.locator('#pe-where-signin');
  await expect(warning).toHaveText(`Codex isn’t signed in on ${host.name}, so this agent’s turns there would stop until it is. Run this on ${host.name}:`);
  await expect(sheet.locator('.pe-signin code'), 'the command, to copy').toHaveText('codex login');
  await expect(where).toHaveAttribute('aria-describedby', /pe-where-signin/);
  await expect(where, 'a warning, not a refusal: the host’s status can be wrong').not.toHaveAttribute('aria-invalid', 'true');
  // Signed in now, as the host says at its next connect: the sheet opened again has no warning.
  started.hosts.set(host.id, { ...started.hosts.status(host.id), signIns: { at: Date.now(), harnesses: [{ name: 'codex', state: 'signed-in' }] } });
  const again = await openSettings(page, () => null);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  await expect(again.locator('#pe-where')).toBeVisible();
  await expect(again.locator('#pe-where-signin')).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test('#1608 at 375 px the card’s and Runs on’s sign-in warnings are tidy: nothing over, cut off or broken mid-word', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const host = hostWith('narrow.example.com', { 'claude-code': 'signed-out', codex: 'signed-out', 'kiro-cli': 'signed-in' });
  const settings = await openSettings(page, () => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  // The list shows one card, the picked host’s: pick this one.
  await settings.getByRole('option', { name: new RegExp(host.name.replace(/\./g, '\\.')) }).click();
  const card = settings.getByRole('region', { name: host.name, exact: true });
  await expect(card.locator('.ho-signin')).toHaveCount(2);
  await card.locator('.ho-signin').last().scrollIntoViewIfNeeded();
  await expectTidyText(page, 'the host’s card with two sign-in warnings');
  const persona = started.app.rt.createPersona({ handle: 'on-narrow', backend: 'codex', remote: { hostId: host.id } });
  const sheet = await openSettings(page, () => null);
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  await expect(sheet.locator('#pe-where-signin')).toBeVisible();
  await sheet.locator('.pe-signin').scrollIntoViewIfNeeded();
  await expectTidyText(page, 'Runs on with its sign-in warning');
});
