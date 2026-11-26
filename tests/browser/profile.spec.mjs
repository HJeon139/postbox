// Settings › Profile (#558): the one looking is in the top bar by their initials, which open their profile. Their name
// starts as their account’s and says so; what they save is shown as agents will be told, an edit and a cleared field
// both take, and it is kept in Postbox. The person is the specs’ fixture (FIXTURE_PERSON), never a real account.

import { expect, test } from '@playwright/test';
import { audit } from './hosts.mjs';
import { allowPageError, failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
// A Postbox of its own for each test: whether a person has ever saved changes what their Name field starts as.
/** @type {Awaited<ReturnType<typeof startPostbox>>[]} */
const started = [];
test.beforeEach(async () => {
  app = await startPostbox('profile');
  started.push(app);
});
// Stopped once the file is done: a page still open on one would log its stream closing as an error.
test.afterAll(async () => {
  for (const one of started) await one.stop();
});
failOnPageErrors(test);

const saved = () => Object.values(app.rt.s.people)[0]?.profile ?? {};

async function profileTab(page) {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // The button is the one looking, and opens on their profile.
  await expect(dialog.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  // And keyboard focus is on that tab, not on the first one, so Enter stays on the profile.
  await expect(dialog.getByRole('tab', { name: 'Profile' })).toBeFocused();
  await settled(page);
  return dialog;
}

for (const width of [1280, 375])
  test(`at ${width} px you see who you are, write a profile, see what agents are told, change it and clear it`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const dialog = await profileTab(page);
    const told = dialog.locator('#pf-told');
    const icon = page.locator('header.topbar #me-icon');
    // The one looking is the account’s person: their initials in the top bar, and their name where they can change it.
    await expect(icon).toHaveAttribute('data-initials', 'RE');
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Robin Example');
    await expect(dialog.locator('#pf-name-help')).toContainText('from your computer’s account, and agents aren’t told it until you save');
    for (const name of ['Also written as', 'Preferences', 'Time zone', 'Pronouns']) await expect(dialog.getByLabel(name, { exact: true })).toHaveValue('');
    await expect(told).toHaveText('Nothing yet: agents call you “the person”.');
    // Each field stops at its bound as you type, so a save never cuts what you see.
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveAttribute('maxlength', '80');
    await expect(dialog.getByLabel('Preferences')).toHaveAttribute('maxlength', '2000');
    await audit(page, 'the Profile tab with nothing saved');

    await dialog.getByLabel('Name', { exact: true }).fill('Robin');
    await dialog.getByLabel('Also written as').fill('github: robin-example\nRobin Q.');
    await dialog.getByLabel('Preferences').fill('Short replies.\nAmerican spelling.');
    await dialog.getByLabel('Pronouns').fill('they/them');
    await dialog.getByRole('button', { name: 'Save profile' }).click();
    await expect(told).toHaveText(
      '- Name: Robin\n- Also written as: robin-example (github), Robin Q. (other)\n- Pronouns: they/them\n- Preferences: Short replies. American spelling.',
    );
    await expect(icon, 'the initials follow the saved name').toHaveAttribute('data-initials', 'R');
    expect(saved()).toEqual({
      name: 'Robin',
      aliases: [
        { kind: 'github', value: 'robin-example' },
        { kind: 'other', value: 'Robin Q.' },
      ],
      pronouns: 'they/them',
      preferences: 'Short replies. American spelling.',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'the page doesn’t scroll sideways').toBe(false);
    await audit(page, 'a saved profile');

    // It is Postbox’s, not the browser’s: a new page shows it, and no longer says the name is the account’s.
    const again = await profileTab(page);
    await expect(again.getByLabel('Name', { exact: true })).toHaveValue('Robin');
    await expect(again.getByLabel('Also written as')).toHaveValue('github: robin-example\nother: Robin Q.');
    await expect(again.locator('#pf-name-help')).not.toContainText('computer’s account');

    // Clearing a field takes it out, and clearing them all is no profile: they’re called what their account calls them.
    await again.getByLabel('Pronouns').fill('');
    await again.getByRole('button', { name: 'Save profile' }).click();
    await expect(again.locator('#pf-told')).not.toContainText('Pronouns');
    for (const name of ['Name', 'Also written as', 'Preferences']) await again.getByLabel(name, { exact: true }).fill('');
    await again.getByRole('button', { name: 'Save profile' }).click();
    await expect(again.locator('#pf-told')).toHaveText('Nothing yet: agents call you “the person”.');
    expect(saved()).toEqual({});
    await expect(page.locator('header.topbar #me-icon')).toHaveAttribute('data-initials', 'RE');
  });

test('a name you emptied stays empty, and a thirteenth other name is refused in words', async ({ page }) => {
  // The server answers the thirteenth with 422, which the page logs.
  allowPageError(page, /status of 422/);
  const dialog = await profileTab(page);
  await dialog.getByLabel('Name', { exact: true }).fill('');
  await dialog.getByLabel('Pronouns').fill('they/them');
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  await expect(dialog.locator('#pf-told')).toHaveText('- Pronouns: they/them');
  // The account’s name isn’t put back in the field, to be saved again unasked: not now, and not on the next open.
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
  const reopened = await profileTab(page);
  await expect(reopened.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(reopened.locator('#pf-name-help')).not.toContainText('computer’s account');
  await reopened.getByLabel('Also written as').fill(Array.from({ length: 13 }, (_, i) => `git: name ${i}`).join('\n'));
  await reopened.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('A profile keeps 12 other names, and this has 13.')).toBeVisible();
  expect(saved()).toEqual({ pronouns: 'they/them' });
});

test('a handle you choose is what you are mentioned by: the tab says which it is, refuses one a mention can’t be written with, and tells agents nothing', async ({
  page,
}) => {
  const dialog = await profileTab(page);
  const handle = dialog.getByLabel('Handle', { exact: true });
  const help = dialog.locator('#pf-handle-help');
  await expect(handle).toHaveValue('');
  await expect(help).toContainText('Left empty, you are @robin, your account’s login.');
  // A refused save is a 422 the browser logs.
  allowPageError(page, /status of 422/);
  await handle.fill('robin example');
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('.toast', { hasText: 'A handle is 2–24 letters, digits, - or _, and starts with a letter' })).toBeVisible();
  expect(saved().handle).toBeUndefined();
  await handle.fill('@Robby');
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  await expect.poll(() => saved().handle).toBe('Robby');
  await expect(help).toContainText('You are @Robby.');
  await expect(dialog.getByLabel('Handle', { exact: true })).toHaveValue('Robby');
  // What agents are told doesn’t carry it: how to reach you is no part of the turn’s note.
  await expect(dialog.locator('#pf-told')).not.toContainText('Robby');
  // People shows what each person is mentioned by.
  await dialog.getByRole('tab', { name: 'People' }).click();
  await expect(dialog.getByRole('listbox', { name: 'People' }).getByRole('option').first()).toContainText('@Robby');
  await audit(page, 'People with a handle saved');
});
