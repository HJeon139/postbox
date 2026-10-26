// The Work view for an agent on a remote host (#120): one line per host says its files aren’t recorded, with the
// host’s name; the files the agent edited there are listed without lines, a diff or Restore, in the pane, in a turn
// and full screen; a host’s commit doesn’t claim to be pushed or not; axe finds nothing; and nothing scrolls
// sideways. Every case runs at 1280 and at 375 px.
// The server’s own work ledger is fed two recorded Claude Code turns (tests/fixtures/claude-code/ledger-*.jsonl) as
// turns on a host, the way the runtime does for a remote persona. No host or SSH is involved. Moved from
// tools/check-work-remote.mjs (#303).

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { failOnPageErrors, startPostbox, synced, windowWidth } from './postbox.mjs';
import { SIZES } from './work-pane.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const NOTE = 'Files on host.example.com aren’t recorded: Postbox lists the ones @builder edited there, with no diff and no Restore.';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let conv;
/** @type {any} */
let host;
/** @type {string[]} */
const turnIds = [];
/** @type {any[]} */
let edits;

/** One recorded Claude Code turn, fed to the ledger as a turn on the host that has ended, as the runtime does. */
async function hostTurn(se, project, name) {
  const { rt, store } = app;
  const turn = { id: `turn_remote_${turnIds.length + 1}`, threadId: conv.id, startedAt: Date.now(), remote: { hostId: host.id } };
  turnIds.push(turn.id);
  // What the runtime keeps on the session for a host turn: its folder on the host. The turn is over (done).
  rt.updateSession(se.id, { remoteTurn: { hostId: host.id, turn: `host-${turn.id}`, rtTurn: turn.id, folder: '/workspace/rec', state: 'done' } });
  const ledger = rt.ledger;
  ledger.startTurn(turn, { se: store.state.sessions[se.id], folder: null, projectFolder: project.folder ?? null });
  const m = createStreamMapper(
    {
      text() {},
      activity() {},
      status() {},
      compaction() {},
      toolUse: (u) => ledger.toolUse(turn, u),
      toolResult: (r) => ledger.toolResult(turn, r),
      taskEnded: (x) => ledger.taskEnded(turn, x),
      usage: (u) => ledger.usage(turn, u),
    },
    { now: () => Date.now() },
  );
  const lines = (await readFile(new URL(`../fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')).trim().split('\n');
  for (const l of lines) m.push(JSON.parse(l));
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
}

test.beforeAll(async () => {
  app = await startPostbox('work-remote');
  const { rt, store } = app;
  host = rt.addHost({ name: 'host.example.com' });
  const project = Object.values(store.state.projects)[0];
  const persona = rt.createPersona({ handle: 'builder' });
  conv = rt.createThread({ projectId: project.id, title: 'Remote build', personaIds: [persona.id] });
  const se = rt.sessionsIn(conv.id).find((x) => x.personaId === persona.id);
  for (const name of ['ledger-edits', 'ledger-push']) await hostTurn(se, project, name);
  edits = app.store.state.work[conv.id].filter((e) => e.kind === 'edit');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// Light, as the old check ran it.
test.use({ colorScheme: 'light' });

/** Opens the conversation with Work in the pane, once the page has heard everything the server did. */
async function openWork(page) {
  await page.goto(`${app.origin}/#/t/${conv.id}?work`);
  await synced(page, app);
  const pane = page.getByRole('complementary', { name: 'Work' });
  await expect(pane).toBeVisible();
  return pane;
}
/** That axe finds nothing in the page, against WCAG 2.1 A and AA. */
async function axe(page, where) {
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover, as a tag it loads would be.
  await page.evaluate(`${AXE};0`);
  const found = await page.evaluate(() =>
    /** @type {any} */ (window).axe
      .run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
      .then((r) =>
        r.violations.map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help} at ${v.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join(', ')}`,
        ),
      ),
  );
  expect(found, `axe, ${where}`).toEqual([]);
}
/** Nothing scrolls sideways: not the page (against the window the test set), the pane or the full form. */
async function noSideways(page, where) {
  const over = await page.evaluate((width) => {
    const out = [];
    const d = document.documentElement;
    if (d.scrollWidth > width + 1) out.push(`the page by ${d.scrollWidth - width} px`);
    for (const sel of ['.wp-body', '.rpane', '.pane-full']) {
      const el = document.querySelector(sel);
      if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel} by ${el.scrollWidth - el.clientWidth} px`);
    }
    return out;
  }, windowWidth(page));
  expect(over, `scrolls sideways ${where}`).toEqual([]);
}
/** The diffs the page asks the server for from now on. @param {import('@playwright/test').Page} page */
function watchDiffs(page) {
  /** @type {string[]} */
  const asked = [];
  page.on('request', (r) => /\/work\/files\/[^/]+\/diff/.test(r.url()) && asked.push(r.url()));
  return asked;
}

test('the ledger kept the host’s edits as steps, with no file to restore', async () => {
  const work = app.store.state.work[conv.id];
  expect([work.filter((e) => e.kind === 'file').length, edits.length]).toEqual([0, 6]);
  await expect(app.rt.restoreWork(conv.id, edits[0].id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/is on host\.example\.com/) });
});

/** the pane says, in one line with the host’s name, that files on the host aren’t recorded */
async function paneNote(page) {
  const pane = await openWork(page);
  await expect(pane.locator('.work-host-note'), 'one line for one host').toHaveCount(1);
  await expect(pane.locator('.work-host-note')).toHaveText(NOTE);
  // The files the agent edited, newest first, three at most, each saying where it is.
  const rows = pane.locator('[id^="wc-edit-"]');
  await expect(rows).toHaveCount(3);
  for (const r of await rows.all()) await expect(r).toHaveText(/on host\.example\.com, not recorded$/);
  const files = pane.getByRole('region', { name: /^Files/ });
  await expect(files.getByRole('heading'), 'four files: notes.txt, hello.md, untracked.txt and sub.txt').toHaveText(/^Files4$/);
  await expect(pane.locator('[id^="restore-"]')).toHaveCount(0);
  await expect(pane).not.toContainText(/Asking git|No files changed/);
  // Each turn’s line says so too.
  for (const id of turnIds) await expect(pane.locator(`#wturn-s-${id}`)).toContainText(/files edited on host\.example\.com/);
  await axe(page, 'in the pane');
  await noSideways(page, 'in the pane');
}

/** a turn lists its host’s files, and one opens full screen with no diff and no Restore */
async function turnFiles(page) {
  const pane = await openWork(page);
  const asked = watchDiffs(page);
  const first = turnIds[0];
  await pane.locator(`#wturn-s-${first}`).click();
  await expect(pane.locator(`#wturn-${first}`)).toHaveAttribute('open', '');
  const edit = edits.find((e) => e.turnId === first && e.rel === 'notes.txt');
  const row = pane.locator(`#wc-t-${first}-${edit.id}`);
  await expect(row, 'the turn’s files').toBeVisible();
  await row.focus();
  await page.keyboard.press('Enter');
  const full = page.locator('.pane-full');
  const summary = full.locator(`details[open] > summary#wsum-${edit.id}`);
  await expect(summary, 'notes.txt, opened').toBeVisible();
  await expect(summary).toBeFocused();
  const body = full.locator(`details:has(> summary#wsum-${edit.id})`);
  await expect(body).toContainText(/on host\.example\.com, not recorded/);
  await expect(body).toContainText(/Postbox didn’t read it, so it has no diff of it and nothing to restore/);
  await expect(full.locator('.work-diff, [id^="restore-"]')).toHaveCount(0);
  await expect(full.locator('.work-host-note')).toHaveCount(1);
  await axe(page, 'in one turn, full screen');
  await noSideways(page, 'in one turn, full screen');
  expect(asked, 'the page asked for no diff').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(full, 'full screen to end').toHaveCount(0);
}

/** full screen, the files on the host, and a commit there that doesn’t claim to be pushed */
async function fullScreen(page) {
  const pane = await openWork(page);
  const asked = watchDiffs(page);
  await pane.getByRole('button', { name: 'Full screen' }).click();
  const full = page.locator('.workpane.pane-full');
  const files = full.locator('#work-files');
  await expect(files, 'Work full screen').toBeVisible();
  await expect(files.locator('.work-host-note')).toHaveText(NOTE);
  // One row per file, however many turns edited it: notes.txt in both.
  const paths = await files.locator('summary .work-path').allTextContents();
  expect(paths.sort()).toEqual(['hello.md', 'notes.txt', 'sub.txt', 'untracked.txt']);
  await expect(files.getByRole('heading', { name: /^Files/ })).toHaveText(/^Files4$/);
  await expect(full.locator('.work-tile b'), 'the summary’s tiles are still there').toHaveCount(3);
  const vcs = full.locator('#work-vcs');
  await expect(vcs).toContainText(/Ledger test on master · @builder on host\.example\.com/);
  await expect(vcs).not.toContainText(/Not pushed|files unknown/);
  await expect(vcs).toContainText(/Made branch feature · @builder on host\.example\.com/);
  await expect(vcs).toContainText(/Pushed feature to \/workspace\/remote\.git \(feature → feature\) · @builder on host\.example\.com/);
  await expect(full.locator('#work-commands')).toContainText(/@builder on host\.example\.com/);
  // The edit opens, still without a diff.
  const notes = edits.find((e) => e.rel === 'notes.txt');
  await full.locator(`#wsum-${notes.id}`).click();
  await expect(full.locator(`details[open] > summary#wsum-${notes.id}`), 'notes.txt, opened').toBeVisible();
  await expect(full.locator(`details:has(> summary#wsum-${notes.id})`)).toContainText(/3 edits in 2 turns by @builder/);
  await axe(page, 'full screen');
  await noSideways(page, 'full screen');
  expect(asked, 'the page asked for no diff').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pane-full'), 'full screen to end').toHaveCount(0);
}

const CASES = /** @type {const} */ ([
  ['the pane says, in one line with the host’s name, that files on the host aren’t recorded', paneNote],
  ['a turn lists its host’s files, and one opens full screen with no diff and no Restore', turnFiles],
  ['full screen, the files on the host, and a commit there that doesn’t claim to be pushed', fullScreen],
]);
for (const { width, height, phone } of SIZES)
  test.describe(`${width} px`, () => {
    test.use(phone ? { viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height } });
    for (const [name, run] of CASES) test(`${width} px: ${name}`, ({ page }) => run(page));
  });
