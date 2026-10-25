// Menus fit the window (#36): an app’s version menu with 30 versions is no taller than the window, starts inside it,
// scrolls, opens with the version shown in view, and clips each summary to one line; the shared menu’s other uses (the
// composer’s +, which opens above its button, and the conversation’s ⋯) still open whole and inside a short window.
// Moved from tools/checks/menus.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

const APP = (n) => `<main style="padding:12px"><p>Version ${n}</p></main>`;
// A summary as long as an agent may write (300 characters).
const SUMMARY = (n) => `Version ${n}: ${'regrouped the pairs by author, then by year, and drew each group on its own row '.repeat(4)}`.slice(0, 300);

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let threadId;
test.beforeAll(async () => {
  app = await startPostbox('menus');
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const librarian = Object.values(store.state.personas).find((p) => p.handle === 'librarian');
  threadId = rt.createThread({ projectId: project.id, title: 'Many versions', personaIds: [librarian.id] }).id;
  const tools = rt.toolsFor(rt.sessionsIn(threadId)[0].id);
  tools.show_app({ id: 'many', title: 'Pair explorer', code: APP(1), permissions: [] });
  for (let n = 2; n <= 30; n++) tools.update_app({ id: 'many', code: APP(n), summary: SUMMARY(n) });
  expect(store.state.apps.many.current).toBe(30);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 1000 } });

const versions = (page) => page.locator('.appframe button[aria-haspopup=menu]');
/** What the app’s frame shows. */
const shown = (page) => page.frameLocator('.transcript .appframe iframe').first().locator('main p');
const menu = (page) => page.locator('.menu');
const item = (page, start) =>
  menu(page)
    .locator('.mi')
    .filter({ hasText: new RegExp(`^${start}`) });

/** The conversation, with its app at v30. */
async function open(page) {
  await page.goto(`${app.origin}/#/t/${threadId}`);
  await synced(page, app);
  await expect(versions(page), 'the app at v30').toHaveText(/^v30/);
}
/** The open menu’s box, how far it scrolls, and the window’s height. */
const menuBox = (page) =>
  menu(page).evaluate((m) => {
    const b = m.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, width: b.width, scroll: m.scrollHeight - m.clientHeight, H: innerHeight };
  });
/** Opens a menu from its button, and checks that it sits whole inside the window. */
async function opensInside(page, button, what) {
  await button.click();
  await expect(menu(page), `${what} opens`).toBeVisible();
  await frames(page);
  const m = await menuBox(page);
  expect(m.top >= 0 && m.bottom <= m.H, `${what} runs from ${Math.round(m.top)} to ${Math.round(m.bottom)} px in a ${m.H} px window`).toBe(true);
  return m;
}
/** The focused item in the open menu, and whether it’s in the menu’s view. */
const focusedItem = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    const m = document.querySelector('.menu');
    if (!a || !m?.contains(a)) return null;
    const b = a.getBoundingClientRect();
    const mb = m.getBoundingClientRect();
    return { text: a.textContent, inView: b.top >= mb.top - 1 && b.bottom <= mb.bottom + 1 };
  });

test('#36 the version menu with 30 versions fits a 1,000 px window, starts inside it, and scrolls', async ({ page }) => {
  await open(page);
  const m = await opensInside(page, versions(page), 'the version menu');
  expect(m.scroll, 'it scrolls, so every version can be reached').toBeGreaterThan(0);
  await expect(menu(page).locator('.mi')).toHaveCount(30);
});

test('#36 each version’s summary is clipped to one line', async ({ page }) => {
  await open(page);
  await opensInside(page, versions(page), 'the version menu');
  const rows = await menu(page)
    .locator('.mi')
    .evaluateAll((items) =>
      items.map((b) => {
        const g = b.querySelector('.grow');
        return { text: b.textContent.slice(0, 12), height: b.getBoundingClientRect().height, clipped: g.scrollWidth > g.clientWidth };
      }),
    );
  // v1’s row, “v1 · first version” and the line under it, is one line of each; every other row is as tall.
  const one = rows.at(-1);
  expect(one.text).toMatch(/^v1 · first/);
  for (const r of rows) expect(r.height, `“${r.text}…” is ${r.height} px tall, and v1 ${one.height} px`).toBeLessThanOrEqual(one.height + 1);
  expect(
    rows.slice(0, 29).filter((r) => !r.clipped),
    'every 300-character summary is clipped',
  ).toEqual([]);
  expect((await menuBox(page)).width).toBeLessThanOrEqual(420);
});

test('#36 the version menu opens with the version shown focused and in view, current or older', async ({ page }) => {
  await open(page);
  // The current version, newest, is first.
  await opensInside(page, versions(page), 'the version menu');
  await expect.poll(() => focusedItem(page)).toEqual({ text: expect.stringMatching(/^v30 · Version 30/), inView: true });
  // An older version near the bottom: choosing it shows it, and the menu then opens on it.
  await item(page, 'v3 · ').click();
  await expect(menu(page), 'the menu closes').toHaveCount(0);
  await expect(shown(page), 'v3 shown').toHaveText('Version 3');
  await opensInside(page, versions(page), 'the version menu');
  await expect.poll(() => focusedItem(page)).toEqual({ text: expect.stringMatching(/^v3 · Version 3/), inView: true });
  expect(await menu(page).evaluate((m) => m.scrollTop), 'the menu scrolled to v3').toBeGreaterThan(0);
  // Back to the current version.
  await item(page, 'v30 · ').click();
  await expect(shown(page), 'v30 shown').toHaveText('Version 30');
});

test('#36 in a short window, the composer’s + menu (above its button) and ⋯ (below) open whole, inside it', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 1280, height: 420 });
  for (const [what, button] of [
    ['the + menu', page.getByRole('button', { name: 'Add a file or a new agent' })],
    ['the ⋯ menu', page.locator('header.topbar button[aria-label^="Actions for"]')],
  ]) {
    await opensInside(page, button, what);
    // Short menus keep their height: nothing in them is squeezed.
    const squeezed = await menu(page)
      .locator('.mi')
      .evaluateAll((items) => items.filter((b) => b.scrollHeight > b.clientHeight + 1).map((b) => b.textContent));
    expect(squeezed, `nothing in ${what} is squeezed`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
  }
});
