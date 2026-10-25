// The shell, driven with real key presses and clicks:
// - an open block from an earlier turn is shown quietly instead of “needs you” (#69);
// - the words for conversations (#4);
// - focus stays on the control you used in a sheet, and goes back to where you opened it (#26);
// - menus close when you click their button again (#29);
// - and a fresh install leads to a first project.
// On the demo’s conversations. Moved from tools/check-shell.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('shell-focus');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const threadNamed = (title) => Object.values(app.store.state.threads).find((t) => t.title === title);

/** Opens a place in Postbox and waits for it to have heard everything the server did. */
async function open(page, hash, origin = app.origin) {
  await page.goto(`${origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}

/** A short description of the focused element: its role or tag, and its name or text. */
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return `${a.getAttribute('role') ?? a.tagName.toLowerCase()}: ${(a.getAttribute('aria-label') ?? a.textContent?.trim().replace(/\s+/g, ' ') ?? '').slice(0, 60)}`;
  });
/** Waits for focus to be on what that describes. */
const focusIs = (page, want) => expect.poll(() => focused(page), { message: 'where focus is' }).toEqual(want);
const focusMatches = (page, want) => expect.poll(() => focused(page), { message: 'where focus is' }).toMatch(want);

const dialog = (page) => page.locator('.backdrop .dialog');
const actions = (page) => page.locator('header.topbar button[aria-label^="Actions for"]');
const plus = (page) => page.getByRole('button', { name: 'Add a file or a new agent' });

// ── #69: an open block from an earlier turn is shown quietly ─────────────────────────────

test('#69 an older open block shows “1 open confirmation”, not needs-you, and goes to the block', async ({ page }) => {
  const { rt, store } = app;
  const t = threadNamed('Corpus planning');
  const se = rt.sessionsIn(t.id).find((x) => x.handle === 'indexer');
  // A block from a turn that has ended, left unanswered.
  rt.toolsFor(se.id, null).show_block({
    block: { id: 'old-ask', type: 'confirm', version: 1, fallback: 'x', statement: 'Rename them?', confirmLabel: 'Rename' },
  });
  await open(page, `#/t/${t.id}`);
  // In @indexer’s row in the sidebar’s Agents section (#105).
  const label = page.locator(`.rail .agent-row [data-open-asks="${se.id}"]`);
  await expect(label).toHaveText('1 open confirmation');
  expect(store.state.sessions[se.id].needs).toBe(null);
  await label.click();
  await focusMatches(page, /Rename/);
  // Answering it clears the line.
  const block = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'old-ask');
  rt.act(t.id, block.id, 'confirm', {});
  await expect(label, 'the line clears once answered').toBeHidden();
});

// ── #26: focus stays on the control you used, and goes back where it came from ──────────

test('#26 new agent: Space on a Tools checkbox keeps focus on it', async ({ page }) => {
  // From the conversation’s ⋯: the overview’s New agent went with it (#320).
  await open(page, `#/t/${threadNamed('Corpus planning').id}`);
  await actions(page).click();
  await page.locator('.menu .mi', { hasText: 'Add an agent' }).click();
  await expect(dialog(page)).toBeVisible();
  const box = page.locator('.d-body [role=checkbox]').nth(1);
  const before = await box.getAttribute('aria-checked');
  const name = (await box.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
  await box.focus();
  await page.keyboard.press('Space');
  await focusIs(page, `checkbox: ${name}`.slice(0, 70));
  await expect(box).not.toHaveAttribute('aria-checked', before ?? '');
  await page.keyboard.press('Space');
  await expect(box).toHaveAttribute('aria-checked', before ?? '');
  await expect(box).toBeFocused();
});

test('#26 new room: Enter on the @indexer chip keeps focus on it', async ({ page }) => {
  await open(page, `#/p/${threadNamed('Corpus planning').projectId}`);
  await page.getByRole('button', { name: 'New room' }).click();
  await expect(dialog(page)).toBeVisible();
  const chip = page.locator('.d-body .chips button', { hasText: '@indexer' });
  await chip.focus();
  await page.keyboard.press('Enter');
  await focusIs(page, 'button: @indexer');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await focusIs(page, 'button: @indexer');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
});

test('#26 settings: Enter on the Projects tab keeps focus on it, and Escape returns to Settings', async ({ page }) => {
  await open(page, '#/');
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  const tab = page.getByRole('tab', { name: 'Projects' });
  await tab.focus();
  await page.keyboard.press('Enter');
  await focusIs(page, 'tab: Projects');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await focusIs(page, 'button: Settings');
});

test('#26 ⋯ › Add an agent… by keyboard, then Escape, returns focus to ⋯', async ({ page }) => {
  await open(page, `#/t/${threadNamed('Corpus planning').id}`);
  await actions(page).focus();
  await page.keyboard.press('Enter');
  await focusIs(page, 'menuitem: Rename…');
  await page.keyboard.press('ArrowDown');
  await focusMatches(page, /^menuitem: Add an agent…/);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  // #4: the sheet says “conversation”, never “thread”.
  await expect(dialog(page)).toContainText('Join this conversation');
  await expect(dialog(page)).toContainText('New conversation in Book corpus');
  await expect(dialog(page)).not.toContainText(/\bthread\b/i);
  await page.keyboard.press('Escape');
  await focusIs(page, 'button: Actions for Corpus planning');
});

test('#26 the folder picker opens with focus on its first entry, and Escape returns to +', async ({ page }) => {
  await open(page, `#/t/${threadNamed('Corpus planning').id}`);
  await plus(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu')).toBeVisible();
  for (let i = 0; i < 5 && !/From the project folder/.test(await focused(page)); i++) await page.keyboard.press('ArrowDown');
  await focusMatches(page, /^menuitem: From the project folder/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.d-body li button').first(), 'focus on the first entry').toBeFocused();
  await page.keyboard.press('Escape');
  await focusIs(page, 'button: Add a file or a new agent');
});

// ── #29: clicking a menu’s button again closes it ──────────────────────────────────────

for (const [name, button] of [
  ['the Postbox mark', (page) => page.locator('header.topbar button.brand')],
  ['the conversation’s ⋯', actions],
  ['the composer’s +', plus],
])
  test(`#29 a second click on ${name} closes its menu`, async ({ page }) => {
    await open(page, `#/t/${threadNamed('Corpus planning').id}`);
    const b = button(page);
    await b.click();
    await expect(page.locator('.menu'), 'the first click opens it').toHaveCount(1);
    await expect(b).toHaveAttribute('aria-expanded', 'true');
    await b.click();
    await expect(page.locator('.menu'), 'the second click closes it').toHaveCount(0);
    await expect(b).toHaveAttribute('aria-expanded', 'false');
    await b.click();
    await expect(page.locator('.menu'), 'a third click opens it again').toHaveCount(1);
    await expect(b).toHaveAttribute('aria-expanded', 'true');
  });

test('#29 a second click closes a menu even after its button repainted under it', async ({ page }) => {
  const t = threadNamed('Corpus planning');
  await open(page, `#/t/${t.id}`);
  await actions(page).click();
  await expect(page.locator('.menu')).toHaveCount(1);
  await actions(page).evaluate((b) => {
    b.dataset.first = 'yes';
  });
  // A rename repaints the top bar, which rebuilds its ⋯ button.
  app.rt.renameThread(t.id, `${t.title} (renamed)`);
  try {
    await expect(page.locator('header.topbar button[data-first]'), 'the top bar repainted').toHaveCount(0);
    await actions(page).click();
    await expect(page.locator('.menu')).toHaveCount(0);
  } finally {
    app.rt.renameThread(t.id, 'Corpus planning');
  }
});

test('#26 ⋯ › Rename… by keyboard returns focus to ⋯ after the top bar repaints with the new name', async ({ page }) => {
  const t = threadNamed('Index the shelf');
  await open(page, `#/t/${t.id}`);
  await actions(page).focus();
  await page.keyboard.press('Enter');
  await focusIs(page, 'menuitem: Rename…');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  try {
    await page.keyboard.insertText(' (2)');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for Index the shelf (2)' })).toBeVisible();
    await focusIs(page, 'button: Actions for Index the shelf (2)');
  } finally {
    app.rt.renameThread(t.id, 'Index the shelf');
  }
});

// ── A fresh install leads to a first project ────────────────────────────────────────────

test('a fresh install, with no project, offers New project, which opens Settings › Projects (#320)', async ({ page }) => {
  const fresh = await startPostbox('shell-fresh', { demo: false });
  try {
    // A fresh install has no projects or conversations. Older seeds made some, so clear them to match.
    Object.assign(fresh.store.state, { projects: {}, threads: {}, sessions: {}, items: {} });
    await page.goto(`${fresh.origin}/#/`);
    await expect(page.locator('.empty-home')).toContainText('Create a project to start.');
    await page.locator('.empty-home').getByRole('button', { name: 'New project' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Projects');
    await page.keyboard.press('Escape');
    await focusIs(page, 'button: New project');
  } finally {
    // Leave the page first, so closing the server doesn’t cut its event stream mid-message.
    await page.goto('about:blank');
    await fresh.stop();
  }
});
