// Work’s viewer (#1446): a room asset, or a file the agents changed as they left it, opened in the pane from its row
// or from a link in a reply. Markdown is drawn, text shows as text, an image as an image; Back returns to the lists
// and to the row it came from. An id from another conversation stays text, a reload opens the viewer again, and on a
// phone, where Work opens full screen, the viewer shows there.

import { expect, test } from '@playwright/test';
import { writeAsset } from '../../server/assets.mjs';
import { VIEWER } from '../../shared/limits.mjs';
import * as arrange from '../arrange.mjs';
import { png } from '../review-files-fixture.mjs';
import { failOnPageErrors, PHONE, startPostbox, synced } from './postbox.mjs';

let app;
let conv;
let other;
/** @type {Record<string, string>} */
const ids = {};
const SCRIPT = 'export const x = "<img src=x onerror=alert(1)>";\n';

test.beforeAll(async () => {
  app = await startPostbox('work-viewer');
  const { rt, store } = app;
  conv = Object.values(store.state.threads).find((t) => t.title === 'Asset explorer');
  other = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
  const write = async (room, name, bytes, type) => {
    const r = await writeAsset(store, rt.assets.roomBlobs(), { kind: 'write', room, name, bytes, type, author: 'librarian' });
    if (!r.ok) throw new Error(r.message);
    return r.id;
  };
  ids.plan = await write(conv.id, 'notes/plan.md', Buffer.from('# The plan\n\nRead **every** note first.\n'), 'text/markdown');
  ids.dot = await write(conv.id, 'pics/dot.png', png(40, 30), 'image/png');
  ids.long = await write(conv.id, 'logs/long.txt', Buffer.from(`${'line of the log\n'.repeat(VIEWER.textBytes / 16)}the end\n`), 'text/plain');
  ids.theirs = await write(other.id, 'theirs.md', Buffer.from('# Not here\n'), 'text/markdown');
  const kept = await arrange.storeBlob(rt, Buffer.from(SCRIPT));
  ids.file = 'wf_scriptjs';
  arrange.addWork(rt, conv.id, {
    id: ids.file,
    kind: 'file',
    path: '/p/src/script.mjs',
    rel: 'src/script.mjs',
    handles: ['librarian'],
    before: { exists: false },
    after: { exists: true, size: kept.size, sha256: kept.sha256, binary: false },
  });
  const se = arrange.sessionsIn(rt, conv.id)[0];
  arrange.post(rt, conv.id, {
    kind: 'agent',
    sessionId: se.id,
    personaId: se.personaId,
    handle: se.handle,
    status: 'done',
    text: `I wrote \`notes/plan.md\` and \`script.mjs\`. The picture is ${ids.dot}; the other room’s is ${ids.theirs}, and \`nothing.md\` isn’t one.`,
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const open = async (page, query = '?work') => {
  await page.goto(`${app.origin}/#/t/${conv.id}${query}`);
  await synced(page, app);
};
const reply = (page) => page.locator('.transcript .md').filter({ hasText: 'I wrote' });

test('a reply links the room’s assets and changed files it names, and nothing else', async ({ page }) => {
  await open(page, '');
  const links = reply(page).locator('a.room-ref');
  await expect(links).toHaveText(['notes/plan.md', 'script.mjs', ids.dot]);
  await expect(links.nth(0)).toHaveAttribute('href', `#/t/${conv.id}?work&at=${ids.plan}`);
  await expect(reply(page).getByText(ids.theirs), 'another room’s id stays text').toBeVisible();
  await expect(reply(page).locator('a', { hasText: ids.theirs })).toHaveCount(0);
  await expect(reply(page).locator('a', { hasText: 'nothing.md' })).toHaveCount(0);
});

test('a link opens the asset in the pane, Markdown drawn, and Back returns to the lists', async ({ page }) => {
  await open(page, '');
  await reply(page).getByRole('link', { name: 'notes/plan.md' }).click();
  const viewer = page.locator('#work-pane .wv');
  await expect(viewer.getByRole('heading', { name: 'notes/plan.md' })).toBeVisible();
  await expect(viewer.locator('.md').getByRole('heading', { name: 'The plan' })).toBeVisible();
  await expect(viewer.locator('.md strong')).toHaveText('every');
  await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/threads/${conv.id}/assets/${ids.plan}?v=1&download=1`);
  expect(page.url()).toContain(`?work&at=${ids.plan}`);
  await viewer.getByRole('button', { name: 'Back to Work' }).click();
  await expect(page.locator('#work-pane #wc-assets-h')).toBeVisible();
  expect(page.url()).not.toContain('at=');
});

test('Back puts focus on the reply’s link the viewer was opened from, by keyboard', async ({ page }) => {
  await open(page, '');
  const link = reply(page).getByRole('link', { name: 'notes/plan.md' });
  await link.focus();
  await page.keyboard.press('Enter');
  const back = page.locator('#wv-back');
  await expect(back).toBeVisible();
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#work-pane .wv')).toHaveCount(0);
  await expect(link).toBeFocused();
});

test('an asset row opens by keyboard, focus goes to Back, and Back returns focus to the row', async ({ page }) => {
  await open(page);
  const row = page.locator(`#wc-asset-${ids.plan}`);
  await row.focus();
  await page.keyboard.press('Enter');
  const back = page.locator('#wv-back');
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row).toBeFocused();
});

test('a changed file shows as the agents left it, as text, and Diff opens it full screen', async ({ page }) => {
  await open(page, '');
  await reply(page).getByRole('link', { name: 'script.mjs' }).click();
  const viewer = page.locator('#work-pane .wv');
  await expect(viewer.locator('pre.wv-pre')).toHaveText(SCRIPT.trimEnd());
  await expect(viewer.locator('pre.wv-pre img'), 'the file’s text is text').toHaveCount(0);
  await expect(viewer.getByText('/p/src/script.mjs')).toBeVisible();
  await viewer.getByRole('button', { name: 'Diff' }).click();
  await expect(page.locator('.workpane.pane-full')).toBeVisible();
  expect(page.url()).toContain(`full=work&at=${ids.file}`);
});

test('an image asset shows as an image', async ({ page }) => {
  await open(page, `?work&at=${ids.dot}`);
  const img = page.locator('#work-pane .wv img.wv-img');
  await expect(img).toHaveAttribute('alt', 'pics/dot.png');
  await expect.poll(() => img.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBe(40);
});

test('a long text shows what the route sends, the viewer’s limit in bytes, and says so in the same unit as its size', async ({ page }) => {
  await open(page, `?work&at=${ids.long}`);
  const viewer = page.locator('#work-pane .wv');
  await expect(viewer).toContainText('Showing the first 262.1 KB of 262.2 KB. Download it for the rest.');
  await expect(viewer).toContainText('· 262.2 KB');
  await expect.poll(() => viewer.locator('pre.wv-pre').evaluate((el) => el.textContent?.length)).toBe(VIEWER.textBytes);
  await expect(viewer.locator('pre.wv-pre')).not.toContainText('the end');
});

test('another conversation’s asset id opens nothing', async ({ page }) => {
  await open(page, `?work&at=${ids.theirs}`);
  await expect(page.locator('#work-pane .wv')).toContainText('This conversation has no such asset or file.');
  await expect(page.locator('#work-pane .wv .md')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ ...PHONE, viewport: { width: 375, height: 812 } });
  test('the viewer shows in the pane over the conversation, and nothing scrolls sideways', async ({ page }) => {
    await open(page, `?work&at=${ids.file}`);
    await expect(page.locator('#work-pane .wv pre.wv-pre')).toHaveText(SCRIPT.trimEnd());
    const over = await page.evaluate(() =>
      [document.documentElement, document.querySelector('.wp-body')].map((el) => (el ? el.scrollWidth - el.clientWidth : 0)),
    );
    expect(over).toEqual([0, 0]);
    await page.locator('#wv-back').click();
    await expect(page.locator('#work-pane #wc-assets-h')).toBeVisible();
  });
});
