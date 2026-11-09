// A composer keeps its unsent attachments with its draft (#849). The text of a draft was kept per conversation, but the
// files attached to it were lost, without a word, whenever the composer mounted again: on going to another
// conversation, in this project or another, and back, and on closing a topic thread’s panel and opening it again.
// - each of those three switches keeps the attachments, as it keeps the text, and so does a reload;
// - an upload still going at the switch finishes into the draft it was added to, and one that fails says so;
// - removing an attachment, or sending the message, takes it out of the kept draft.
// Files are attached through the composer’s own file input (Upload from computer), and the switch is a change of the
// page’s address, as following a link in the rail is. Each test has conversations of its own.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('draft-attachments');
  // A second project, for a switch to a conversation in another project.
  app.store.emit('project', { id: 'pr_draft849', name: 'Other project', folder: app.root });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with @librarian, in the first project or the one named. */
function conversation(title, projectId = Object.values(app.rt.s.projects)[0].id) {
  const { rt } = app;
  return rt.createThread({ projectId, title, personaIds: [rt.personaByHandle('librarian').id] });
}
/** A topic thread of its own, from a message of yours in a new conversation. */
function topicThread(title) {
  const t = conversation(title);
  const root = app.rt.addItem(t.id, { kind: 'user', text: 'Start a thread from here.' });
  return { t, side: app.rt.startTopic(t.id, root.id).threadId };
}
/** Goes to a page of the app as a link in the rail does, without reloading it. */
const go = (page, hash) => page.evaluate((to) => (location.hash = to), hash);
/** Goes to a conversation, and waits until it’s the one shown. */
async function open(page, t) {
  await go(page, `#/t/${t.id}`);
  await expect(page.locator('.crumbs > .title'), `${t.title} opens`).toHaveText(t.title);
}
/** Attaches a small text file through the composer’s Upload from computer input. */
const attach = (page, scope, name) =>
  page.locator(`${scope} .composer input[type=file][multiple]`).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`Notes in ${name}`) });
const chips = (page, scope) => page.locator(`${scope} .composer .attachments .att`);
/** Waits until the composer shows these attachments, each uploaded. */
async function shows(page, scope, names, message) {
  await expect(chips(page, scope), message).toHaveText(names.map((n) => new RegExp(`^${n.replace('.', '\\.')} · \\d`)));
}

test('#849 attachments are kept over a switch to a conversation in another project and back, and over a reload', async ({ page }) => {
  const here = conversation('Keeps files');
  const there = conversation('In the other project', 'pr_draft849');
  await page.goto(`${app.origin}/#/t/${here.id}`);
  await synced(page, app);
  await page.locator('#composer-input').fill('Have a look at these.');
  await attach(page, '.main', 'one.txt');
  await attach(page, '.main', 'two.txt');
  await shows(page, '.main', ['one.txt', 'two.txt'], 'both upload');
  await open(page, there);
  await expect(page.locator('#composer-input'), 'its composer has no text').toHaveValue('');
  await expect(chips(page, '.main'), 'its composer has no attachments').toHaveCount(0);
  await open(page, here);
  await expect(page.locator('#composer-input'), 'the text is kept').toHaveValue('Have a look at these.');
  await shows(page, '.main', ['one.txt', 'two.txt'], 'the attachments are kept with it');
  await page.reload();
  await synced(page, app);
  await shows(page, '.main', ['one.txt', 'two.txt'], 'and kept over a reload, as the text is');
  await page.locator('.main .composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.transcript .me-card .attachments .att'), 'the kept files send').toContainText(['one.txt', 'two.txt']);
});

test('#849 attachments are kept over a switch to another conversation in the same project and back', async ({ page }) => {
  const here = conversation('Keeps a file');
  const next = conversation('Next door');
  await page.goto(`${app.origin}/#/t/${here.id}`);
  await synced(page, app);
  await attach(page, '.main', 'kept.txt');
  await shows(page, '.main', ['kept.txt'], 'it uploads');
  await open(page, next);
  await expect(chips(page, '.main'), 'the next conversation’s composer has no attachments').toHaveCount(0);
  await open(page, here);
  await shows(page, '.main', ['kept.txt'], 'the attachment is kept');
});

test('#849 a topic thread’s attachments are kept when its panel is closed and opened again', async ({ page }) => {
  const { t, side } = topicThread('Panel files');
  await page.goto(`${app.origin}/#/t/${t.id}/side/${side}`);
  await synced(page, app);
  await expect(page.locator('#side-input')).toBeVisible();
  await attach(page, 'aside.sidepanel', 'panel.txt');
  await shows(page, 'aside.sidepanel', ['panel.txt'], 'it uploads to the panel’s composer');
  await page.locator('aside.sidepanel').getByRole('button', { name: 'Close thread' }).click();
  await expect(page.locator('aside.sidepanel'), 'the panel closes').toHaveCount(0);
  await expect(chips(page, '.main'), 'the conversation’s composer doesn’t take it').toHaveCount(0);
  await go(page, `#/t/${t.id}/side/${side}`);
  await shows(page, 'aside.sidepanel', ['panel.txt'], 'the panel’s composer has it again');
});

test('#849 an upload still going at a switch finishes into its own draft, and one that fails there says so', async ({ page }) => {
  const here = conversation('Slow upload');
  const next = conversation('Elsewhere');
  /** @type {((how: 'continue' | 'fail') => void)[]} */
  const held = [];
  await page.route('**/api/files', (route) => {
    held.push(
      (how) => void (how === 'fail' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Disk full."}' }) : route.continue()),
    );
  });
  await page.goto(`${app.origin}/#/t/${here.id}`);
  await synced(page, app);
  await attach(page, '.main', 'slow.txt');
  await expect(chips(page, '.main'), 'it is uploading').toHaveText([/^slow\.txt · uploading/]);
  await open(page, next);
  await expect(chips(page, '.main'), 'the next conversation’s composer doesn’t take it').toHaveCount(0);
  await expect.poll(() => held.length, { message: 'the upload reached the server' }).toBe(1);
  held[0]('continue');
  await expect(chips(page, '.main'), 'nor when it finishes').toHaveCount(0);
  await open(page, here);
  await shows(page, '.main', ['slow.txt'], 'it finished into the draft it was added to');

  allowPageError(page, /500/);
  await attach(page, '.main', 'broken.txt');
  await expect(chips(page, '.main').filter({ hasText: 'broken.txt' }), 'the second is uploading').toContainText('uploading');
  await open(page, next);
  await expect.poll(() => held.length, { message: 'the second upload reached the server' }).toBe(2);
  await open(page, here);
  await expect(chips(page, '.main'), 'back before it ends, the draft shows it still uploading').toHaveText([/^slow\.txt · \d/, /^broken\.txt · uploading/]);
  held[1]('fail');
  await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t attach broken.txt' }), 'the failure is told').toBeVisible();
  await shows(page, '.main', ['slow.txt'], 'the failed one leaves the draft, the finished one stays');
});

test('#849 removing an attachment, or sending it, takes it out of the kept draft', async ({ page }) => {
  const here = conversation('Clears files');
  const next = conversation('Away');
  await page.goto(`${app.origin}/#/t/${here.id}`);
  await synced(page, app);
  await attach(page, '.main', 'drop.txt');
  await attach(page, '.main', 'send.txt');
  await shows(page, '.main', ['drop.txt', 'send.txt'], 'both upload');
  await page.locator('.main .composer').getByRole('button', { name: 'Remove drop.txt' }).click();
  await open(page, next);
  await open(page, here);
  await shows(page, '.main', ['send.txt'], 'the removed one isn’t kept');
  await page.locator('.main .composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.transcript .me-card .attachments'), 'it sends').toContainText('send.txt');
  await open(page, next);
  await open(page, here);
  await expect(page.locator('.transcript .me-card .attachments'), 'back in the conversation').toContainText('send.txt');
  await expect(chips(page, '.main'), 'the sent one isn’t kept in the draft').toHaveCount(0);
  await page.reload();
  await synced(page, app);
  await expect(page.locator('.transcript .me-card .attachments'), 'after a reload').toContainText('send.txt');
  await expect(chips(page, '.main'), 'nor over a reload').toHaveCount(0);
});
