// The turn’s list (#195): under the turn’s last reply, its line and a row per thing it did, in the ledger’s order,
// matching Work; “N more” expands in place; each row opens Work full screen at its item, and Escape comes back to the
// row, where the conversation was; a long path keeps its file name at 375 px; axe finds nothing in the list or in
// Work’s new sections; and a row follows the ledger after the turn. At 1280 and at 375 px.
// On the demo’s “Citation fixes”, after the mock @researcher does its first turn of work there: it reads two files,
// changes four, runs four commands, files an issue and shows an app. Moved from tools/check-work-list.mjs (#303).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { turnLine } from '../../shared/work.mjs';
import { turnRows } from '../../shared/work-list.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let speed;
let conv;
let turn;
let last;
let rows;
test.beforeAll(async () => {
  // The mock’s turn of work can take most of a minute on a busy computer.
  test.setTimeout(120_000);
  speed = process.env.POSTBOX_MOCK_SPEED;
  process.env.POSTBOX_MOCK_SPEED = '0.1';
  app = await startPostbox('work-list');
  const { rt, store } = app;
  conv = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
  rt.sendMessage(conv.id, { text: 'Fix the citation script' });
  await expect.poll(() => store.items(conv.id).some((i) => i.work), { message: 'the turn’s list', timeout: 60_000 }).toBe(true);
  await expect.poll(() => rt.turns.size, { message: 'the turn to end', timeout: 60_000 }).toBe(0);
  turn = entries().find((e) => e.kind === 'turn');
  last = store
    .items(conv.id)
    .filter((i) => i.turnId === turn.id)
    .findLast((i) => i.kind === 'agent' || i.kind === 'block');
  rows = turnRows(entries(), turn.id, { folders: [store.state.projects[conv.projectId].folder] });
});
test.afterAll(async () => {
  await app?.stop();
  if (speed === undefined) delete process.env.POSTBOX_MOCK_SPEED;
  else process.env.POSTBOX_MOCK_SPEED = speed;
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const entries = () => app.store.state.work[conv.id];
const list = (page) => page.locator(`[data-key="${last.id}"] .work-list-turn`);
const row = (page, n) => list(page).locator('.wl-row').nth(n);
async function open(page) {
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(list(page).locator('ul'), 'the list under the turn’s last reply').toBeVisible();
  await settled(page);
}
/** That axe finds nothing in what a selector finds, against WCAG 2.1 A and AA. */
async function axe(page, sel, where) {
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover, as a tag it loads would be.
  await page.evaluate(`${AXE};0`);
  const found = await page.evaluate(
    (s) =>
      /** @type {any} */ (window).axe
        .run({ include: [[s]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
        .then((r) =>
          r.violations.map(
            (v) =>
              `${v.id}: ${v.nodes
                .slice(0, 3)
                .map((n) => n.target.join(' '))
                .join(', ')}`,
          ),
        ),
    sel,
  );
  expect(found, `axe, ${where}`).toEqual([]);
}

/** the list is under the turn’s last reply only, its line on top, its rows in the ledger’s order */
async function placed(page) {
  await open(page);
  await expect(page.locator('.transcript .work-list-turn'), 'no list elsewhere in the turn').toHaveCount(1);
  expect(last.kind, 'the turn ends with its reply').toBe('agent');
  await expect(list(page).locator('.work-chip')).toHaveText(turnLine(entries(), turn.id));
  await expect(list(page).locator('ul')).toHaveAttribute('aria-label', 'What this turn did');
  expect([...new Set(rows.map((r) => r.kind))], 'files, the app, the issue, the commands, then reads').toEqual([
    'file',
    'publish',
    'external',
    'command',
    'reads',
  ]);
  await expect(list(page).locator('.wl-row'), 'five rows before “more”').toHaveCount(5);
  await expect(list(page).locator('.wl-more')).toHaveText(`${rows.length - 5} more`);
}

/** “N more” expands in place, with focus on the first row it showed, and the rows match Work */
async function more(page) {
  await open(page);
  await list(page).locator('.wl-more').click();
  await expect(list(page).locator('.wl-row'), 'every row').toHaveCount(rows.length);
  await expect(row(page, 5), 'focus on the sixth row').toBeFocused();
  expect(
    await list(page)
      .locator('.wl-row')
      .evaluateAll((as) => as.map((a) => /** @type {HTMLElement} */ (a).dataset.at)),
  ).toEqual(rows.map((r) => r.at));
  await expect(list(page).locator('.wl-command').first()).toHaveText(/^Ran the citation script|node cite\.mjs refs\.bib/);
  await expect(list(page).locator('.wl-reads')).toHaveText('Read 2 files');
}

/** each row opens Work full screen at its item, and Escape comes back to the row, or leaves Work in the pane at 375 px */
async function rowsOpenWork(page, { width }) {
  test.setTimeout(90_000);
  await open(page);
  await list(page).locator('.wl-more').click();
  await expect(list(page).locator('.wl-row')).toHaveCount(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const top = await page.evaluate(() => scrollY);
    await row(page, i).click();
    await expect(page.locator('.pane-full .work-view'), `Work full screen for row ${i}`).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toContain(`at=${encodeURIComponent(r.at)}`);
    expect(page.url()).toContain('full=work');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id), { message: `row ${i} (${r.kind}) opens Work at ${r.at}` })
      .toMatch(new RegExp(`^(wsum-)?${r.at}$`));
    if (i === 0) await axe(page, '.pane-full .work-view', `${width} px, full-screen Work`);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pane-full'), 'Work back in the pane').toHaveCount(0);
    if (width >= 768) {
      await expect(row(page, i), `focus back on row ${i}`).toBeFocused();
      expect(Math.abs((await page.evaluate(() => scrollY)) - top), 'the conversation stayed where it was').toBeLessThan(400);
    } else {
      // Work stays open in the pane, over the conversation (#233): close it to reach the next row.
      await page.locator('#work-close').click();
      await expect(page.locator('aside.workpane')).toHaveCount(0);
    }
  }
}

/** a long path keeps its file name, nothing scrolls sideways, and axe finds nothing in the list */
async function fits(page, { width }) {
  await open(page);
  const cut = await list(page)
    .locator('.wl-file')
    .evaluateAll((as) =>
      as.map((a) => {
        const n = /** @type {HTMLElement} */ (a.querySelector('.wl-name'));
        return { name: n.textContent, whole: n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= a.getBoundingClientRect().right + 1 };
      }),
    );
  expect(cut.length, 'the four files').toBeGreaterThanOrEqual(4);
  for (const f of cut) expect(f.whole, `${f.name} whole`).toBe(true);
  expect(
    cut.some((f) => f.name === 'notes.md'),
    'the note outside the project',
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'the page doesn’t scroll sideways').toBeLessThanOrEqual(width + 1);
  await axe(page, `[data-key="${last.id}"] .work-list-turn`, `${width} px`);
}

const CASES = [
  ['the list is under the turn’s last reply only, its line on top, its rows in the ledger’s order', placed],
  ['“N more” expands in place, with focus on the first row it showed, and the rows match Work', more],
  [
    'each row opens Work full screen at its item, and Escape comes back to the row, where the conversation was (at 375 px, Work stays in the pane, #233)',
    rowsOpenWork,
  ],
  ['a long path keeps its file name, nothing scrolls sideways, and axe finds nothing in the list', fits],
];
for (const { width, height, phone } of [
  { width: 1280, height: 900, phone: false },
  { width: 375, height: 812, phone: true },
])
  test.describe(`${width} px`, () => {
    test.use(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
    for (const [name, run] of CASES) test(`${width} px: ${name}`, ({ page }) => run(page, { width }));
  });

// Last, since it changes the ledger the tests above read.
test('1280 px: a row follows the ledger after the turn: a background command that ends, and an app retired, say so', async ({ page }) => {
  const { rt, store } = app;
  await open(page);
  await list(page).locator('.wl-more').click();
  const bg = entries().find((e) => e.kind === 'command' && e.background);
  const command = page.locator(`#wl-${turn.id}-${bg.id}`);
  await expect(command).toContainText('didn’t report how it ended');
  rt.ledger.jobUpdate({ threadId: conv.id, toolUseId: bg.toolUseId }, { state: 'stopped', by: 'you' });
  await expect(command, 'the row says stopped').toHaveText(/stopped$/);
  // An app retired after the turn (#193): its row says so.
  const pub = entries().find((e) => e.kind === 'publish');
  store.emit('app', { ...store.state.apps[pub.blockId], retired: { by: 'researcher', reason: 'Superseded.', replacedBy: null, at: Date.now() } });
  await expect(page.locator(`#wl-${turn.id}-${pub.id}`), 'the app’s row says retired').toHaveText(/v1 · retired$/);
});
