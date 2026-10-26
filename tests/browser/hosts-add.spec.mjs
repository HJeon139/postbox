// A host just added to the Hosts tab of Settings (#120), with the real host manager (server/remote/hosts.mjs) rather
// than a fake: with no token on this computer it says Not installed at once, and its card offers Install…, which has
// focus, so the next step is the next key press. At 1280 and 375 px, with axe. Postbox’s data folder is new, so no
// host has a token and nothing dials ssh: the spec never installs. Moved from tools/check-hosts-add.mjs (#303).

import { expect, test } from '@playwright/test';
import { audit, card, freshHost, openHosts, SIZES } from './hosts.mjs';
import { failOnPageErrors, startPostbox } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  // No hosts option: the server makes the real manager, keeping tokens in its data folder, which has none.
  app = await startPostbox('hosts-add');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/**
 * Adds a host as a person does, by typing its destination and pressing Add host or Enter; returns its id.
 * @param {import('@playwright/test').Page} page @param {string} name @param {'button' | 'enter'} how
 */
async function add(page, name, how) {
  const before = new Set(Object.keys(app.store.state.hosts ?? {}));
  const form = page.getByRole('region', { name: 'Add a host' });
  await form.getByRole('textbox', { name: 'SSH destination' }).fill(name);
  if (how === 'enter') await form.getByRole('textbox', { name: 'SSH destination' }).press('Enter');
  else await form.getByRole('button', { name: 'Add host' }).click();
  const added = () => Object.keys(app.store.state.hosts ?? {}).find((id) => !before.has(id)) ?? '';
  await expect.poll(added, { message: how === 'enter' ? 'Enter in the field adds it' : 'Add host adds it' }).not.toBe('');
  return added();
}

/**
 * A host just added: Not installed, Install… on its card with focus, and nothing dialed.
 * @param {import('@playwright/test').Page} page @param {string} id @param {string} name @param {string} how
 */
async function justAdded(page, id, name, how) {
  const c = card(page, name);
  const install = c.getByRole('button', { name: 'Install…' });
  await expect(install, `${how}: Install… for ${name}`).toBeVisible();
  expect.soft(app.store.state.hostStatus?.[id]?.state, `${how}: the manager says ${name} isn’t installed`).toBe('not-installed');
  await expect.soft(c.locator('.status-tag'), `${how}: its card says Not installed`).toHaveText('Not installed');
  await expect.soft(c.getByText(/isn’t installed on .+ yet/), `${how}: and says to install it first`).toBeVisible();
  await expect.soft(install, `${how}: Install… has focus`).toBeFocused();
}

for (const { width, use } of SIZES)
  test.describe(`at ${width} px`, () => {
    test.use(use);

    test('#120 a host just added by Add host or Enter says Not installed at once, and its Install… has focus and asks first', async ({ page }) => {
      freshHost(app, null);
      await openHosts(page, app);
      await test.step('Add host', async () => {
        const first = await add(page, 'build.example.com', 'button');
        await justAdded(page, first, 'build.example.com', 'Add host');
        await audit(page, 'a host just added');
      });
      await test.step('Enter', async () => {
        const second = await add(page, 'user@host.example.com', 'enter');
        await justAdded(page, second, 'user@host.example.com', 'Enter');
        await audit(page, 'two hosts just added');
      });
      // Install… opens the confirm, which installs nothing until its own Install is pressed (the spec stops there).
      await test.step('Install…', async () => {
        await card(page, 'user@host.example.com').getByRole('button', { name: 'Install…' }).click();
        const confirm = page.getByRole('alertdialog', { name: 'Install Postbox on user@host.example.com?' });
        await expect
          .soft(confirm.locator('.ho-install-text'), 'Install… asks first')
          .toContainText(/Install Postbox’s host program on user@host\.example\.com\?/);
        await audit(page, 'the install confirm for a host just added');
      });
    });
  });
