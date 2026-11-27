// Skipped items and a screen reader (#1048). With items off screen skipped (content-visibility: auto, #712a), Chromium
// keeps no accessibility tree for a skipped item’s contents, so a reader reached only the items that had drawn: 23 of
// a 500-item room’s messages. The item’s own box isn’t skipped, so each item is an article that carries its place among
// the room’s items, “4 of 500”, whether it has drawn or not, and Alt+↑/↓ reaches each in turn. Chromium’s DevTools
// protocol doesn’t list aria-posinset, so the place is read from the DOM, beside the articles in the tree.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced, wholeRoom } from './postbox.mjs';
import { bigRoom, still } from './view-skipped-fixture.mjs';

// Tracing is off: its snapshots walk every item with its skipped styles each action (view-skipped.spec.mjs).
test.use({ trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-skipped-places');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/**
 * The articles in Chromium’s accessibility tree, and each shown item’s role and place from the DOM.
 * @param {import('@playwright/test').Page} page
 */
async function places(page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  const inTree = nodes.filter((n) => !n.ignored && n.role?.value === 'article').length;
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('#main > .item')]
      .filter((n) => !(/** @type {HTMLElement} */ (n).hidden))
      .map((n) => [n.getAttribute('role'), n.getAttribute('aria-posinset'), n.getAttribute('aria-setsize')]),
  );
  return { inTree, items };
}

/** Every shown item an article, at its place of all of them. @param {string[][]} items */
const counted = (items) => items.map((_, i) => ['article', String(i + 1), String(items.length)]);

/** Opens a room of `count` items and waits for it to mount whole and hold still. @param {any} page @param {number} count */
async function open(page, count) {
  const conv = bigRoom(app, `Places ${count}`, count);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator('#main.transcript > .item')).toHaveCount(count, { timeout: 15_000 });
  await expect(page.locator('#main.transcript')).toHaveClass(/cv-skip/);
  await still(page);
}

test.describe('the window off', () => {
  wholeRoom(test);
  test('in a 500-item room, every item reaches the tree with its place, drawn or skipped', async ({ page }) => {
    await open(page, 500);
    const { inTree, items } = await places(page);
    expect(items).toEqual(counted(items));
    expect(inTree, 'every shown item is in the accessibility tree').toBe(items.length);
    // An agent’s reply replaced draws nothing (speaker-line.mjs, drawsNothing): it leaves the count, and the items after
    // it move up a place.
    const conv = /** @type {string} */ (new URL(page.url()).hash.split('/').pop());
    const agent = app.store.items(conv).filter((/** @type {any} */ x) => x.kind === 'agent')[20];
    app.rt.threads.patchItem(conv, agent.id, { status: 'replaced' });
    await expect.poll(async () => (await places(page)).items.length).toBe(items.length - 1);
    const fewer = await places(page);
    expect(fewer.items).toEqual(counted(fewer.items));
    // A new item takes the next place, and every other item’s count grows with it.
    await page.locator('#composer-input').fill('One more.');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await places(page)).items.length).toBe(items.length);
    const after = await places(page);
    expect(after.items).toEqual(counted(after.items));
    // Alt+↑ from the composer reaches the last item, which says it’s the last of them.
    await page.locator('#composer-input').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const at = document.activeElement?.getAttribute('aria-posinset');
          return !!at && at === document.activeElement?.getAttribute('aria-setsize');
        }),
      )
      .toBe(true);
    // A command the person ran is a group (thread.mjs): it keeps that role and says no place, and still counts, so the
    // item after it is one place further on.
    app.rt.threads.addItem(conv, { kind: 'command', command: 'ls', cwd: '.', status: 'done', exitCode: 0, output: '' });
    app.rt.threads.addItem(conv, { kind: 'user', text: 'Note: after the command' });
    // Whatever else arrives meanwhile (the agent’s answer to “One more.”), each article’s place is its index among the
    // shown items, and the group’s index is skipped, not reused.
    await expect(page.locator('#main > .item').filter({ hasText: 'Note: after the command' })).toHaveCount(1);
    const command = page.locator('#main > .item.cmd-block');
    await expect(command).toHaveAttribute('role', 'group');
    await expect(command).not.toHaveAttribute('aria-posinset', /./);
    const withGroup = (/** @type {(string | null)[][]} */ items) =>
      items.map(([role], i) => (role === 'group' ? ['group', null, null] : ['article', String(i + 1), String(items.length)]));
    await expect
      .poll(async () => {
        const { items: now } = await places(page);
        return JSON.stringify(now) === JSON.stringify(withGroup(now));
      })
      .toBe(true);
  });
});

test('in a room under the window’s ceiling, mounted whole, every item reaches the tree with its place', async ({ page }) => {
  await open(page, 200);
  const { inTree, items } = await places(page);
  expect(items).toEqual(counted(items));
  expect(inTree).toBe(items.length);
});

test('in a room the window holds, items are articles with no place, since only those near the view are mounted', async ({ page }) => {
  const conv = bigRoom(app, 'Places held', 500);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${conv.id}`);
  await synced(page, app);
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-window', 'on');
  await still(page);
  const { items } = await places(page);
  expect(items.length, 'the window mounts fewer than all').toBeLessThan(500);
  expect(items.every(([role, at, of]) => role === 'article' && at === null && of === null)).toBe(true);
});
