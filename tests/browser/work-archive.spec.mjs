// An archived turn in the Work view (#305; designs/305-archive-turns.md, “Opening an old turn”, Browser): the pane’s
// Turns list keeps a summary row for it, with its counts, and “Show details” loads it through the turn route and draws
// it as a live turn; full screen lists the archived turns and opens one. A file that can’t be read says so, and the row
// keeps its counts. On the conversation tests/work-archive-fixture.mjs makes: t1 archived with a command, a change and
// a host edit, t2 hot, t3 archived with one failed command and a damaged file, t4 archived with a missing file.

import { expect, test } from '@playwright/test';
import { seedArchived } from '../work-archive-fixture.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { noSideways, SIZES } from './work-pane.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let conv;
test.beforeAll(async () => {
  app = await startPostbox('work-archive', { demo: false });
  ({ conv } = await seedArchived(app, app.root));
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const UNREADABLE = 'This turn’s details couldn’t be read';
/** How long a seeded conversation may take to load and draw, with the events late, on a busy runner. */
const LOAD = 30_000;

/** Opens the conversation at that pane address, and waits for what shows it drew, then for it to hear the server. */
async function open(page, r, drawn) {
  await page.goto(`${app.origin}/#/t/${conv.id}${r}`);
  await expect(page.locator(drawn)).toBeVisible({ timeout: LOAD });
  await synced(page, app);
}
const row = (page, turnId) => page.locator(`#wturn-${turnId}`);

/** The pane’s Turns list: a summary row per archived turn, Show details, and a row of it opening full screen. */
async function paneRows(page) {
  await open(page, '?work', '#wturn-t1');
  const turns = page.getByRole('region', { name: 'Turns' });
  await expect(turns.locator('details.wc-turn')).toHaveCount(3);
  await expect(row(page, 't1')).toContainText('1 file +1 −0');
  await expect(row(page, 't1')).toContainText('1 command');
  await expect(row(page, 't3')).toContainText('1 command (1 failed)');
  // The totals keep the archived turns: five turns at $0.25.
  await expect(page.getByRole('region', { name: 'Spend' })).toContainText('$1.25 · 5 turns');

  await page.locator('#wturn-s-t1').click();
  await row(page, 't1').getByRole('button', { name: 'Show details' }).click();
  const command = row(page, 't1').getByRole('button', { name: /\$ ls/ });
  await expect(command).toBeVisible();
  await expect(row(page, 't1').getByRole('button', { name: /a\.txt/ })).toBeVisible();
  await noSideways(page, 'with an archived turn opened in the pane');

  await command.click();
  const full = page.locator('.workpane.pane-full .work-view');
  await expect(full.locator('p.work-turn')).toContainText('One turn: alpha');
  await expect(full.locator('[id="wsum-c1"]')).toBeFocused();
  await full.locator('[id="wsum-c1"]').click();
  await expect(full.locator('#work-commands')).toContainText('the command’s output');
  await noSideways(page, 'with an archived turn full screen');
}

/** A damaged file: Show details says the turn’s details couldn’t be read, and the row keeps its counts. */
async function paneUnreadable(page) {
  await open(page, '?work', '#wturn-t3');
  await page.locator('#wturn-s-t3').click();
  await row(page, 't3').getByRole('button', { name: 'Show details' }).click();
  await expect(row(page, 't3')).toContainText(UNREADABLE);
  await expect(row(page, 't3')).toContainText('1 command (1 failed)');
}

/** Full screen lists the archived turns with their counts, and Show details opens one, drawn as a live turn. */
async function fullList(page) {
  await open(page, '?work&full=work', '#work-archived');
  const list = page.getByRole('region', { name: 'Earlier turns' });
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list.locator('li').first()).toContainText('1 command (1 failed)');
  // Effort by agent keeps them too: @alpha’s five turns, four of them archived.
  await expect(page.locator('#work-effort tbody tr').first().locator('td.num').first()).toHaveText('5');
  await list.locator('li', { hasText: '1 file +1 −0' }).getByRole('link', { name: 'Show details' }).click();
  const full = page.locator('.workpane.pane-full .work-view');
  await expect(full.locator('p.work-turn')).toContainText('One turn: alpha');
  await expect(full.locator('[id="wsum-c1"]')).toBeVisible();
  await expect(full.locator('#work-files')).toContainText('a.txt');
  await noSideways(page, 'full screen on an archived turn');
}

/** Full screen on a turn whose file is damaged or missing: it says so, and keeps the summary’s counts. */
async function fullUnreadable(page) {
  await open(page, '?work&full=work&turn=t3', '.work-archived-note');
  const note = page.locator('.workpane.pane-full .work-archived-note');
  await expect(note).toContainText(UNREADABLE);
  await expect(note).toContainText('1 command (1 failed)');
  await open(page, '?work&full=work&turn=t4', '.work-archived-note');
  await expect(page.locator('.workpane.pane-full .work-archived-note')).toContainText(UNREADABLE);
}

const CASES = [
  ['the pane keeps a summary row per archived turn, and Show details draws it as a live turn', paneRows],
  ['a damaged file says its details couldn’t be read, and the row keeps its counts', paneUnreadable],
  ['full screen lists the archived turns, and Show details opens one', fullList],
  ['full screen on a turn whose file can’t be read says so, with its counts', fullUnreadable],
];

for (const { width, height, phone } of SIZES)
  test.describe(`${width} px`, () => {
    test.use(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
    for (const [name, run] of CASES) test(`${width} px: ${name}`, ({ page }) => run(page));
  });
