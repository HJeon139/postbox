// The Hosts tab of Settings (#120): adding a host, a refused destination with the server’s own message, installing
// with describeInstall’s exact text first, a failed install’s next step, and editing its settings and a project’s
// folder there. Each step is checked at 1280 and 375 px, with axe. Its status as the host manager reports it, and
// removing a host, are hosts-status.spec.mjs. With a fake host manager (tests/browser/hosts.mjs), so nothing connects
// to a host. Moved from tools/check-hosts.mjs (#303).

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { describeInstall, installOutcome } from '../../server/remote/install.mjs';
import { checkDestination, checkHostPath } from '../../shared/remote-settings.mjs';
import { audit, card, freshHost, MINUTE, openHosts, SIZES, startHosts, VERSION } from './hosts.mjs';
import { allowPageError, failOnPageErrors } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startHosts>>['app']} */
let app;
/** @type {Awaited<ReturnType<typeof startHosts>>['fake']} */
let fake;
test.beforeAll(async () => {
  ({ app, fake } = await startHosts('hosts'));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const NAME = 'build.example.com';
/** The settings in the design’s table, each with a field in the editor. */
const SETTINGS = [
  ...['name', 'stallTimeout', 'permissionWaitMax', 'idleTimeout', 'logRetention', 'logMaxBytes', 'keepAlive-interval', 'keepAlive-count'],
  ...['dedicatedConnection', 'forwardAgent', 'denyPrompts', 'nodePath', 'claudePath', 'kiroPath', 'codexPath', 'detach', 'signInCheck'],
];
const installs = () => fake.calls.filter((c) => c[0] === 'install').length;

/** @param {import('@playwright/test').Page} page */
async function adding(page) {
  freshHost(app, fake);
  const settings = await openHosts(page, app);
  await expect.soft(settings.getByText('No hosts yet.'), 'with no hosts, it says so').toBeVisible();
  const form = settings.getByRole('region', { name: 'Add a host' });
  const field = form.getByRole('textbox', { name: 'SSH destination' });
  const refused = '-oProxyCommand=x';
  await field.fill(refused);
  await form.getByRole('button', { name: 'Add host' }).click();
  const said = /** @type {any} */ (checkDestination(refused)).error;
  await expect.soft(form.getByRole('alert'), 'a destination ssh would read as an option is refused with the shared check’s message').toHaveText(said);
  await expect.soft(field, 'the field is marked invalid').toHaveAttribute('aria-invalid', 'true');
  expect.soft(Object.keys(app.store.state.hosts ?? {}), 'and nothing was added').toEqual([]);

  await field.fill(NAME);
  await form.getByRole('button', { name: 'Add host' }).click();
  await expect.poll(() => Object.values(app.store.state.hosts ?? {}).map((h) => h.name), { message: 'Add host adds it' }).toEqual([NAME]);
  const id = Object.keys(app.store.state.hosts)[0];
  await expect(card(page, NAME), 'its card').toBeVisible();
  // Not installed: the action is Install, which asks first.
  fake.set(id, { state: 'not-installed' });
  await expect(card(page, NAME).getByRole('button', { name: 'Install…' })).toBeVisible();
  await expect.soft(card(page, NAME).locator('.status-tag'), 'a host not installed says so').toHaveText('Not installed');
  await audit(page, 'the Hosts tab');
}

/** @param {import('@playwright/test').Page} page */
async function installing(page) {
  const id = freshHost(app, fake, NAME);
  fake.set(id, { state: 'not-installed' });
  await openHosts(page, app);
  await card(page, NAME).getByRole('button', { name: 'Install…' }).click();
  // The alert dialog’s name is its title.
  const confirm = page.getByRole('alertdialog', { name: `Install Postbox on ${NAME}?` });
  await expect(confirm, 'it asks, as an alert dialog').toBeVisible();
  const expected = describeInstall(app.store.state.hosts[id], { version: VERSION, dataDir: join(app.root, 'data') }).text;
  expect.soft(await confirm.locator('.ho-install-text').textContent(), 'the install confirm shows describeInstall’s text exactly').toBe(expected);
  expect.soft(installs(), 'reading what it does installs nothing').toBe(0);
  await audit(page, 'the install confirm');

  // A failed install shows its message and next step, and offers to install again: not “tries again on its own”.
  try {
    installOutcome(NAME, VERSION, { code: 1, signal: null, stdout: '', stderr: 'mkdir: cannot create directory: No space left on device\n' });
  } catch (e) {
    fake.installError = e;
  }
  const ie = /** @type {any} */ (fake.installError);
  expect(ie, 'installOutcome refuses an install that exited 1').toBeTruthy();
  allowPageError(page, /status of 502/);
  await confirm.getByRole('button', { name: 'Install', exact: true }).click();
  const result = confirm.getByRole('alert');
  await expect(result.locator('.callout'), 'the failure').toBeVisible();
  await expect.soft(result, 'a failed install shows its message').toContainText(ie.message);
  await expect.soft(result, 'and its next step').toContainText(ie.next.replace(/`/g, ''));
  await expect.soft(result, 'a failed install doesn’t say Postbox tries again on its own').not.toContainText('tries again on its own');
  const again = confirm.getByRole('button', { name: 'Install again' });
  await expect.soft(again, 'and offers Install again').toBeVisible();
  await audit(page, 'a failed install');

  fake.installError = null;
  await again.click();
  await expect(confirm, 'the confirm closes').toBeHidden();
  expect.soft(installs(), 'Install again installs').toBe(2);
  await expect.soft(page.getByRole('status').filter({ hasText: `Installed Postbox on ${NAME}` }), 'an install that works says so').toBeVisible();
}

for (const { width, use } of SIZES)
  test.describe(`at ${width} px`, () => {
    test.use(use);

    test('#120 Add host refuses a destination ssh would read as an option, then adds one, which says it’s not installed', async ({ page }) => {
      await adding(page);
    });

    test('#120 Install… shows describeInstall’s text first, and a failed install its next step and Install again', async ({ page }) => {
      await installing(page);
    });

    test('#120 the editor has every setting, refuses one out of range and a relative folder, and saves in their units', async ({ page }) => {
      const id = freshHost(app, fake, NAME);
      fake.set(id, { state: 'disconnected' });
      await openHosts(page, app);
      const c = card(page, NAME);
      await c.getByRole('button', { name: `Edit settings for ${NAME}` }).click();
      const project = Object.values(app.store.state.projects)[0];
      const f = fields(c, project);
      await test.step('what it shows', () => editorShows(page, c, id, f));
      await test.step('what it refuses', () => editorRefuses(c, id, f));
      await test.step('what it saves', () => editorSaves(id, project, f));
    });
  });

/** The editor’s fields a test types in, by their labels. @param {import('@playwright/test').Locator} c @param {any} project */
const fields = (c, project) => ({
  stall: c.getByRole('spinbutton', { name: 'Stop a quiet turn after', exact: true }),
  unit: c.getByRole('combobox', { name: 'Stop a quiet turn after, unit' }),
  deny: c.getByRole('checkbox', { name: 'Deny permission prompts instead of waiting (unattended runs)' }),
  signIn: c.getByRole('textbox', { name: 'Sign-in check' }),
  folder: c.getByRole('textbox', { name: project.name, exact: true }),
  save: c.getByRole('button', { name: 'Save' }),
});

/** @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} c @param {string} id @param {ReturnType<typeof fields>} f */
async function editorShows(page, c, id, f) {
  await expect(f.stall).toBeVisible();
  // Each field’s id is the one the editor gives it: ho-, the host’s id, and the setting.
  const missing = [];
  for (const k of SETTINGS) if (!(await c.locator(`[id="ho-${id}-${k}"]`).count())) missing.push(k);
  expect.soft(missing, 'the editor has every setting in the design’s table').toEqual([]);
  await expect.soft(f.stall, 'stallTimeout shows 15').toHaveValue('15');
  await expect.soft(f.unit, 'in min').toHaveValue('min');
  await expect.soft(f.deny, 'denyPrompts is there, in D2’s words, off by default').toHaveAttribute('aria-checked', 'false');
  await expect
    .soft(f.signIn, 'signInCheck is an argument list, never a shell string')
    .toHaveAccessibleDescription(/one argument per line, run without a shell/);
  await audit(page, 'the editor');
}

/** Out of range: said in the unit you typed, and nothing is saved. @param {import('@playwright/test').Locator} c @param {string} id @param {ReturnType<typeof fields>} f */
async function editorRefuses(c, id, f) {
  await f.stall.fill('5');
  await f.stall.press('Tab');
  await expect.soft(f.stall, 'a value out of range says the range').toHaveAccessibleErrorMessage('Stop a quiet turn after must be 10 min to 24 h.');
  await f.folder.fill('app');
  await f.folder.press('Tab');
  const relative = /** @type {any} */ (checkHostPath('app', `The project’s folder on ${NAME}`)).error;
  await expect.soft(f.folder, 'a project folder that isn’t absolute is refused with the shared check’s message').toHaveAccessibleErrorMessage(relative);
  await f.save.click();
  await expect
    .soft(c.getByRole('alert'), 'Save refuses while a field is wrong, and says so')
    .toHaveText('2 fields need a change before this can be saved: see the message under each.');
  expect.soft(app.store.state.hosts[id].settings.stallTimeout, 'and nothing is saved').toBe(15 * MINUTE);
}

/** @param {string} id @param {any} project @param {ReturnType<typeof fields>} f */
async function editorSaves(id, project, f) {
  await f.stall.fill('20');
  await f.folder.fill('/home/user/app');
  await f.signIn.fill('klist\n-s');
  await f.deny.click();
  await f.save.click();
  await expect.poll(() => app.store.state.projects[project.id].hostFolders?.[id], { message: 'and the project’s folder on the host' }).toBe('/home/user/app');
  const saved = app.store.state.hosts[id].settings;
  expect.soft(saved.stallTimeout, 'Save stores a changed setting in its unit').toBe(20 * MINUTE);
  expect.soft(saved.denyPrompts, 'and denyPrompts').toBe(true);
  expect.soft(saved.signInCheck, 'and signInCheck as an argument list').toEqual(['klist', '-s']);
  await expect(f.stall, 'the editor closes').toBeHidden();
}
