// The folder picker stays usable around symbolic links (#28): a link that leads out of the project’s folder is marked
// and offers no Open or Attach, a link inside it opens as a folder, and a folder that won’t open (it became a link out
// since it was listed) says why above the list, which stays, with its Up. On a project whose folder, in the spec’s
// temp folder, holds the links. Moved from tools/checks/folder-picker.mjs (#303). A file whose name holds a
// right-to-left override is listed with it marked, its row’s title naming it, and sending it is refused (#1046), and a
// folder whose name holds an isolate heads the list marked once opened (#1052).

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { escapeRegExp } from '../../shared/regex.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let root;
let away;
let threadId;
/** A file’s name that reads as “ab.txt” reordered: a, a right-to-left override, then b.txt. */
const REVERSED = 'a\u202Eb.txt';
test.beforeAll(async () => {
  app = await startPostbox('folder-picker');
  // The project’s folder, and a folder beside it that its links lead to.
  root = join(app.root, 'project');
  away = join(app.root, 'elsewhere');
  await mkdir(join(root, 'docs', 'later'), { recursive: true });
  await mkdir(away);
  await writeFile(join(root, 'notes.txt'), 'notes');
  await writeFile(join(root, REVERSED), 'reversed');
  await mkdir(join(root, 'in\u2066side'));
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
  await writeFile(join(away, 'secret.txt'), 'not for the picker');
  await symlink(away, join(root, 'away-link'));
  await symlink(join(away, 'secret.txt'), join(root, 'secret-link.txt'));
  await symlink(join(root, 'docs'), join(root, 'docs-link'));
  const { rt, store } = app;
  store.emit('project', { id: 'pr-links', name: 'Linked files', folder: root });
  threadId = rt.createThread({ projectId: 'pr-links', title: 'Links', personaIds: [rt.personaByHandle('librarian').id] }).id;
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const list = (page) => page.locator('.d-body');
/** The listed entry named `name`. */
const row = (page, name) =>
  list(page)
    .locator('li')
    .filter({ has: page.locator('.grow', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) });
const button = (page, label) => list(page).locator('li').getByRole('button', { name: label, exact: true });
const where = (page) => list(page).locator('p.mono');
const error = (page) => list(page).locator('.err[role=alert]');

/** The conversation, with the folder picker open from the composer’s +. */
async function picker(page) {
  await page.goto(`${app.origin}/#/t/${threadId}`);
  await synced(page, app);
  await page.getByRole('button', { name: 'Add a file or a new agent' }).click();
  await page.getByRole('menuitem', { name: /^From the project folder/ }).click();
  await expect(button(page, 'Open docs'), 'the folder picker’s list').toBeVisible();
}

test('#28 a link out of the project’s folder is marked, with no Open or Attach', async ({ page }) => {
  await picker(page);
  for (const name of ['away-link', 'secret-link.txt']) {
    await expect(row(page, name), `${name} is marked`).toContainText('Link to outside the project');
    await expect(row(page, name).getByRole('button'), `${name} offers nothing`).toHaveCount(0);
  }
  // What’s really in the folder is listed as before.
  await expect(row(page, 'docs').getByRole('button')).toHaveAccessibleName('Open docs');
  await expect(row(page, 'notes.txt').getByRole('button')).toHaveAccessibleName('Attach notes.txt');
});

test('#28 a link that stays inside the project’s folder opens the folder it leads to', async ({ page }) => {
  await picker(page);
  await expect(row(page, 'docs-link').getByRole('button')).toHaveAccessibleName('Open docs-link');
  await button(page, 'Open docs-link').click();
  await expect(button(page, 'Attach guide.md'), 'docs-link’s files').toBeVisible();
  // It shows the folder it leads to.
  await expect(where(page)).toHaveText(/\/project\/docs$/);
  await button(page, 'Up').click();
  await expect(button(page, 'Open docs'), 'the project’s folder again').toBeVisible();
});

test('#28 a folder that won’t open says why above the list, which stays, with Up', async ({ page }) => {
  await picker(page);
  await button(page, 'Open docs').click();
  await expect(button(page, 'Open later'), 'docs’s folders').toBeVisible();
  // Since it was listed, docs/later became a link out of the project, which the server refuses to open.
  await rm(join(root, 'docs', 'later'), { recursive: true });
  await symlink(away, join(root, 'docs', 'later'));
  try {
    allowPageError(page, /status of 403/);
    await button(page, 'Open later').click();
    await expect(error(page)).toBeVisible();
    await expect(error(page)).toHaveText('That’s outside the project’s folder.');
    await expect(where(page)).toHaveText(/\/docs$/);
    await expect(button(page, 'Up'), 'Up stays').toBeVisible();
    await expect(button(page, 'Attach guide.md'), 'the list stays').toBeVisible();
    // Up leads back out, and the error goes with it.
    await button(page, 'Up').click();
    await expect(button(page, 'Open docs'), 'the project’s folder again').toBeVisible();
    await expect(error(page)).toBeHidden();
  } finally {
    // Back as it was, a folder, for the tests that come after.
    await rm(join(root, 'docs', 'later'));
    await mkdir(join(root, 'docs', 'later'));
  }
});

test('#1052 a file whose name reorders text is listed with the character marked, and sending it is refused', async ({ page }) => {
  await picker(page);
  await expect(row(page, 'a\uFFFDb.txt'), 'listed with the override marked').toHaveCount(1);
  await expect(list(page).locator('.grow', { hasText: '\u202E' }), 'nowhere shown as it is').toHaveCount(0);
  await expect(row(page, 'a\uFFFDb.txt').getByRole('button')).toHaveAccessibleName('Attach a\uFFFDb.txt');
  await expect(row(page, 'a\uFFFDb.txt'), 'its title names what the mark stands for').toHaveAttribute('title', 'Contains U+202E');
  await expect(row(page, 'notes.txt'), 'a name shown as it is has no title').not.toHaveAttribute('title');
  await button(page, 'Attach a\uFFFDb.txt').click();
  // The attachment is the file as it is on disk, and #1046 refuses sending one whose path holds such a character:
  // replacing it would point the agent at another file, or at none.
  allowPageError(page, /status of 422/);
  await page.locator('.main .composer').getByRole('button', { name: 'Send', exact: true }).click();
  const refused = page.locator('.toast', { hasText: 'Your message didn’t send' });
  await expect(refused, 'the refusal, as the server gives it').toContainText(
    '“a_b.txt” can’t be attached: its name holds a control or invisible character, such as a bidi control. Rename it first.',
  );
  await synced(page, app);
  expect(
    app.store.items(threadId).filter((i) => i.kind === 'user'),
    'nothing was sent',
  ).toEqual([]);
});

test('#1052 a folder whose name holds a bidi isolate is listed, and heads the list once opened, with it marked', async ({ page }) => {
  await picker(page);
  await expect(row(page, 'in\uFFFDside').getByRole('button')).toHaveAccessibleName('Open in\uFFFDside');
  await button(page, 'Open in\uFFFDside').click();
  await expect(list(page).locator('li.empty-note'), 'the folder, opened').toHaveText('This folder is empty.');
  await expect(where(page)).toHaveText(/\/project\/in\uFFFDside$/);
});
