// Skipped items and a screen reader (#1048). With items off screen skipped (content-visibility: auto, #712a), Chromium
// keeps no accessibility tree for a skipped item’s contents until it draws: 23 of a 500-item room’s items have words in
// the tree, before and after #1048. Every item’s box is in the tree, and focusing one draws it. Each is now an article,
// named by its words once focused as it was before, carrying its place among the room’s shown items, “4 of 500”.
// Chromium’s DevTools protocol doesn’t list aria-posinset, so the place is read from the DOM, beside the articles in
// the tree; whether a reader announces it wasn’t run.

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
 * The articles under the transcript in Chromium’s accessibility tree, and each shown item’s role and place from the DOM.
 * @param {import('@playwright/test').Page} page
 */
async function places(page) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#main' });
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  // Every article below #main’s own node, walking the tree from it.
  let inTree = 0;
  const walk = [nodes.find((n) => n.backendDOMNodeId === node.backendNodeId)];
  while (walk.length) {
    const n = walk.pop();
    if (!n) continue;
    if (!n.ignored && n.role?.value === 'article') inTree++;
    for (const c of n.childIds ?? []) walk.push(byId.get(c));
  }
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('#main > .item')]
      .filter((n) => !(/** @type {HTMLElement} */ (n).hidden))
      .map((n) => [n.getAttribute('role'), n.getAttribute('aria-posinset'), n.getAttribute('aria-setsize')]),
  );
  return { inTree, items };
}

/**
 * The accessible name Chromium gives the focused node: what a reader says when focus lands on an item.
 * @param {import('@playwright/test').Page} page
 */
async function focusedName(page) {
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' });
  const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
  await cdp.detach();
  return String(nodes[0]?.name?.value ?? '');
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
    // Posted with no agent to answer it, so no reply lands after the checks below have read the last place.
    app.rt.threads.addItem(conv, { kind: 'user', text: 'Note: one more.' });
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
    // A reader focusing it hears the message: the article is named by its own words, once it has drawn.
    await expect.poll(() => focusedName(page)).toMatch(/\S/);
    // A command the person ran is a group (thread.mjs): it keeps that role and says no place, and still counts, so the
    // item after it is one place further on.
    app.rt.threads.addItem(conv, { kind: 'command', command: 'ls', cwd: '.', status: 'done', exitCode: 0, output: '' });
    app.rt.threads.addItem(conv, { kind: 'user', text: 'Note: after the command' });
    // Each article’s place is its index among the shown items, and the group’s index is skipped, not reused.
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
  // Alt+↑ from the composer reaches the last item, and on up to the first, each named by its words and at its place.
  await page.locator('#composer-input').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator(':focus')).toHaveAttribute('aria-posinset', String(items.length));
  for (let i = 1; i < items.length; i++) await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator(':focus')).toHaveAttribute('aria-posinset', '1');
  await expect.poll(() => focusedName(page)).toMatch(/\S/);
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

test('a counted item the window keeps when it takes hold of the room loses its place, as the window mounts only some', async ({ page }) => {
  // Plain notes, so 190 items stay under the window’s element budget and mount whole (window-default.spec.mjs).
  const projectId = /** @type {any} */ (Object.values(app.store.state.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: 'Places kept', personaIds: [] });
  for (let i = 0; i < 190; i++) app.rt.threads.addItem(room.id, { kind: 'user', text: `Note: ${i}` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await expect(page.locator('#main > .item')).toHaveCount(190);
  await expect(page.locator('#main.transcript')).not.toHaveAttribute('data-window', /./);
  // Focused, the last item is kept as it is when the room is built again (window-keep.mjs).
  await page.locator('#composer-input').focus();
  await page.keyboard.press('Alt+ArrowUp');
  const kept = page.locator(':focus');
  await expect(kept).toHaveAttribute('aria-posinset', /\d/);
  const key = await kept.getAttribute('data-key');
  // A mark on the node itself, so what's checked after the rebuild is the node kept, not one drawn anew.
  await kept.evaluate((n) => Object.assign(n, { keptMark: true }));
  // The room grows past the window’s ceiling, then a resync builds it again, now held by the window.
  for (let k = 0; k < 60; k++) app.rt.threads.addItem(room.id, { kind: 'user', text: `Note: grown ${k}` });
  await expect(page.locator('#main > .item').filter({ hasText: 'Note: grown 59' })).toHaveCount(1);
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  await synced(page, app);
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-window', 'on');
  const node = page.locator(`#main > .item[data-key="${key}"]`);
  await expect(node).toBeAttached();
  expect(await node.evaluate((n) => /** @type {any} */ (n).keptMark)).toBe(true);
  await expect(node).not.toHaveAttribute('aria-posinset', /./);
  await expect(node).not.toHaveAttribute('aria-setsize', /./);
});

test('an item drawn again while focused doesn’t pull focus onto the new node, as before items were articles', async ({ page }) => {
  const projectId = /** @type {any} */ (Object.values(app.store.state.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: 'Places redrawn', personaIds: [] });
  for (let i = 0; i < 5; i++) app.rt.threads.addItem(room.id, { kind: 'user', text: `Note: ${i}` });
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await page.locator('#composer-input').focus();
  await page.keyboard.press('Alt+ArrowUp');
  const last = app.store.items(room.id).at(-1);
  await expect(page.locator(`#main > .item[data-key="${last.id}"]`)).toBeFocused();
  // Drawn again: a new node, whose id isn’t the old one’s (rerender-state.mjs, holdFocus).
  app.rt.threads.patchItem(room.id, last.id, { text: 'Note: 4, edited' });
  const redrawn = page.locator(`#main > .item[data-key="${last.id}"]`);
  await expect(redrawn).toContainText('edited');
  await expect(redrawn).not.toBeFocused();
});
