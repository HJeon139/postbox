// The Telemetry view (designs/telemetry-persona.md, R1, R5, R18, R19): Record this room from the ⋯ menu, Telemetry
// swapping in for Work and back, a reload that keeps it, Make report with the history still ticked after a message,
// Leave out by keyboard with focus kept, Discard, Save and Delete, and File issue with no gh, which shows the text and
// its hash, then copies it and asks to open GitHub’s new-issue page. axe on each. On the demo’s “Citation fixes”
// (tests/browser/pane.mjs). Moved from tools/check-telemetry.mjs (#303).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { fresh, go, paneRoom } from './pane.mjs';
import { failOnPageErrors, settled, synced } from './postbox.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** @type {Awaited<ReturnType<typeof paneRoom>>} */
let room;
let gh;
test.beforeAll(async () => {
  // No gh, so File issue takes the copy path.
  gh = process.env.POSTBOX_GH_BIN;
  process.env.POSTBOX_GH_BIN = '/nonexistent/gh';
  room = await paneRoom('telemetry');
  // A classifier that answers at once, labeling nothing.
  room.app.rt.summarize = async () => ({ text: '{"labels":[]}', costUsd: 0 });
});
test.afterAll(async () => {
  await room?.app.stop();
  if (gh === undefined) delete process.env.POSTBOX_GH_BIN;
  else process.env.POSTBOX_GH_BIN = gh;
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

const VIEW = 'aside.telemetry-view';
const view = (page) => page.locator(VIEW);
/** Picks an item of the conversation’s ⋯ menu. */
async function menu(page, label) {
  await page.locator('#conversation-actions').click();
  await page.getByRole('menuitem').filter({ hasText: label }).click();
}
/** Records this room, from the ⋯ menu, unless it’s recorded already. */
async function recorded(page) {
  if (
    !/^Recording since/.test(
      (await page
        .locator('#recording-badge')
        .textContent()
        .catch(() => '')) ?? '',
    )
  )
    await menu(page, 'Record this room');
  await expect(page.locator('#recording-badge')).toHaveText(/^Recording since \d\d:\d\d$/);
}
/** Whether focus is on a control in the Telemetry view, not dropped to the page. */
const focusInView = (page) =>
  expect
    .poll(() => page.evaluate((v) => !!document.activeElement?.closest(v) && /^(BUTTON|INPUT|SUMMARY)$/.test(document.activeElement?.tagName ?? ''), VIEW), {
      message: 'focus in the view',
    })
    .toBe(true);
const shownHash = (page) => page.evaluate(() => (/sha256 ([0-9a-f]{64})/.exec(document.querySelector('.tv-hash')?.textContent ?? '') ?? [])[1] ?? null);
const button = (page, text) => view(page).getByRole('button', { name: text });
/** What axe finds in what a selector finds, against WCAG 2.1 A and AA. */
async function axe(page, include) {
  // Evaluated as the DevTools protocol does, which the page’s policy on scripts doesn’t cover.
  await page.evaluate(`${AXE};0`);
  return page.evaluate(
    (inc) =>
      /** @type {any} */ (window).axe
        .run({ include: [[inc]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
        .then((r) => r.violations.map((v) => `${v.id}: ${v.help}`)),
    include,
  );
}

test('R1, R5: Record this room from the ⋯ menu; the header says so, and nothing appears in the room', async ({ page }) => {
  await fresh(page, room, 1440);
  const items = await page.locator('#main .item').count();
  await recorded(page);
  await expect(page.locator('#main .item')).toHaveCount(items);
});

test('R18: Telemetry swaps in for Work, the Work button brings Work back, and closing Telemetry does too', async ({ page }) => {
  await fresh(page, room, 1440);
  const work = page.locator('#work-button');
  await work.click();
  await expect(page.locator('aside.workpane')).toBeVisible();
  await menu(page, 'Telemetry report');
  await expect(view(page)).toBeVisible();
  await expect(page.locator('aside.workpane'), 'Telemetry in Work’s place').toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).toMatch(/\?work&telemetry/);
  await expect(work).toHaveAttribute('aria-pressed', 'false');
  await work.click();
  await expect(page.locator('aside.workpane'), 'Work back in its place').toBeVisible();
  await expect(view(page)).toHaveCount(0);
  expect(await page.evaluate((id) => localStorage.getItem(`pb-work-${id}`), room.ids.conv), 'Work is still remembered').toBe('1');
  await menu(page, 'Telemetry report');
  await view(page).getByRole('button', { name: 'Close Telemetry' }).click();
  await expect(page.locator('aside.workpane'), 'Work back after Close').toBeVisible();
  await expect(view(page)).toHaveCount(0);
});

test('R18: a reload at ?telemetry keeps the view', async ({ page }) => {
  await fresh(page, room, 1440, { at: '?telemetry' });
  await expect(view(page)).toBeVisible();
  await page.reload();
  await expect(view(page), 'the Telemetry view after a reload').toBeVisible();
  expect(await page.evaluate(() => location.hash)).toMatch(/telemetry/);
});

/** a message in the room leaves the history ticked; Make report keeps focus in the view */
async function makeReport(page) {
  const { rt } = room.app;
  await page.locator('#tv-history').click();
  // A real message, so the conversation changes and its agent replies.
  rt.sendMessage(room.ids.conv, { text: 'One more question while the view is open.' });
  await expect(page.locator('#main .item', { hasText: 'One more question while the view is open.' })).toBeVisible();
  await settled(page);
  await expect(page.locator('#tv-history'), 'still ticked').toBeChecked();
  await button(page, 'Make report').click();
  await expect(page.locator('.tv-lines button[aria-label^="Leave out line"]').first()).toBeVisible();
  await focusInView(page);
}

/** Leave out by keyboard keeps focus on the toggle, with one name, and changes the hash; axe finds nothing */
async function leaveOut(page) {
  const before = await shownHash(page);
  // The second, so that focus on the view’s first control can’t pass for focus kept.
  const toggle = page.locator('.tv-lines button[aria-label^="Leave out line"]').nth(1);
  const id = await toggle.getAttribute('id');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => shownHash(page), { message: 'the new hash' }).not.toBe(before);
  const same = page.locator(`[id="${id}"]`);
  await expect(same, 'focus stayed on the toggle').toBeFocused();
  await expect(same).toHaveAttribute('aria-pressed', 'true');
  await expect(same, 'one name').toHaveAttribute('aria-label', /^Leave out line \d+$/);
  expect(await axe(page, VIEW)).toEqual([]);
}

/** Discard drops the draft; a new one saves, lists itself and reopens its bytes; axe finds nothing */
async function saveReport(page) {
  const { rt, store } = room.app;
  await button(page, 'Discard').click();
  await expect(button(page, 'Make report')).toBeVisible();
  await focusInView(page);
  const reply = store.items(room.ids.conv).find((i) => i.kind === 'agent');
  rt.act(room.ids.conv, reply.id, '@react', { emoji: '🚩' });
  await synced(page, room.app);
  await button(page, 'Make report').click();
  await expect(page.locator('.tv-lines')).toBeVisible();
  await button(page, 'Save report').click();
  await expect(page.locator('.tv-saved')).toBeVisible();
  await focusInView(page);
  await page.locator('.tv-saved details summary').first().click();
  await expect(page.locator('.tv-saved details pre').first(), 'the saved bytes').toContainText('postbox-telemetry-2');
  expect(await axe(page, VIEW)).toEqual([]);
}

/** File issue with no gh shows the text and its hash, copies it, and asks for the new-issue page; Delete removes the report */
async function fileIssue(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.opened = [];
    w.copied = [];
    w.open = (u) => {
      w.opened.push(String(u));
      return null;
    };
    if (navigator.clipboard)
      navigator.clipboard.writeText = (t) => {
        w.copied.push(String(t));
        return Promise.resolve();
      };
  });
  await page.locator('.tv-saved .tv-findings button').first().click();
  const issue = page.locator('.dialog pre.tv-issue');
  await expect(issue).toBeVisible();
  const shown = await issue.textContent();
  await expect(page.locator('.dialog .d-body')).toContainText(/sha256 [0-9a-f]{64}/);
  expect(await axe(page, '.dialog')).toEqual([]);
  await page.locator('.dialog .d-foot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).opened), { message: 'the new-issue page asked for' })
    .toEqual(['https://github.com/HJeon139/postbox/issues/new']);
  expect(await page.evaluate(() => /** @type {any} */ (window).copied)).toEqual([shown]);
  await view(page).locator('.tv-saved').getByRole('button', { name: 'Delete report' }).click();
  await expect(page.locator('.tv-saved'), 'the report deleted').toHaveCount(0);
}

test('R18, R19: a report made with the history ticked after a message, a line left out by keyboard, discarded, saved, filed with no gh, and deleted', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await fresh(page, room, 1440);
  await recorded(page);
  await go(page, room, room.conv('?telemetry'));
  await test.step('a message in the room leaves the history ticked; Make report keeps focus in the view', () => makeReport(page));
  await test.step('Leave out by keyboard keeps focus on the toggle, with one name, and changes the hash; axe finds nothing', () => leaveOut(page));
  await test.step('Discard drops the draft; a new one saves, lists itself and reopens its bytes; axe finds nothing', () => saveReport(page));
  await test.step('File issue with no gh shows the text and its hash, copies it, and asks for the new-issue page; Delete removes the report', () =>
    fileIssue(page));
});

test('R5: the header’s badge adds no listener that stays, on the Threads page or a conversation', async ({ page }) => {
  const { rt, store } = room.app;
  await fresh(page, room, 1440);
  await recorded(page);
  const listeners = () => page.evaluate(() => import('/app/js/client.mjs').then((m) => m.client.listeners.size));
  const churn = async () => {
    const t = store.state.threads[room.ids.other];
    for (let i = 0; i < 10; i++) rt.putThread({ ...t, title: `${t.title} ${i}` });
    rt.putThread(t);
    await synced(page, room.app);
    await settled(page);
  };
  await go(page, room, `#/p/${store.state.threads[room.ids.conv].projectId}/threads`);
  const threads = await listeners();
  await churn();
  expect(await listeners(), 'the Threads page').toBeLessThanOrEqual(threads);
  await go(page, room, room.conv(''));
  await expect(page.locator('#recording-badge')).toBeVisible();
  const here = await listeners();
  await churn();
  expect(await listeners(), 'the conversation').toBeLessThanOrEqual(here);
});
