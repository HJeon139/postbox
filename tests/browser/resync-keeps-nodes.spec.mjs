// #987: a resync (the page loading its state again, after a restart or a long sleep) threw away every item node of an
// open transcript and built it again, so every app’s frame reloaded and lost what it held. Now an app’s item whose
// record, place and app are the same keeps its node where it is, and its frame. Every other item draws again from the
// new state, as before, so nothing it reads besides its own record goes stale: a term defined, a speaker’s line, a side
// thread’s state. A changed item is drawn from the new state, a moved one goes from its old place, and an app with a
// new version loads it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { away, BODY, mark, order, room, seen } from './resync-fixture.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('resync-keeps-nodes');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

for (const [mode, messages] of /** @type {const} */ ([
  ['a whole room', 20],
  ['a room in its window', 300],
]))
  test(`#987 a resync with nothing changed keeps every app’s node and frame, in ${mode}`, async ({ page }) => {
    await room(app, page, `Resync, ${mode}`, messages, 3);
    expect(await mark(page)).toBe(3);
    const resync = await away(app, page);
    await resync();
    const after = await seen(page);
    expect(after.newApps, 'no app’s node on the page was replaced').toEqual([]);
    expect(after.newFrames, 'no app frame was replaced').toEqual([]);
    expect(after.loads, 'no app frame loaded again').toBe(0);
  });

test('#987 a resync draws what changed while the page was away, and keeps the rest', async ({ page }) => {
  const { t, tools, ids } = await room(app, page, 'Resync with changes', 12, 2);
  await mark(page);
  const items = app.store.items(t.id);
  const changed = items[3];
  const moved = items[6];
  const resync = await away(app, page);
  arrange.setItem(app.rt, t.id, changed.id, { text: 'Message 3, edited while you were away' });
  tools.update_app({ id: ids[1], code: BODY('1, version 2') });
  await expect.poll(() => app.rt.store.state.apps[ids[1]].current).toBe(2);
  // After the app’s new version, which brings it to the end, so the moved message is last.
  arrange.moveToEnd(app.rt, t.id, moved.id, { id: `stub-${moved.id}`, what: 'message', title: 'Message 6' });
  await resync();
  await expect(page.locator(`#main > .item[data-key="${changed.id}"]`)).toContainText('edited while you were away');
  await expect(page.locator(`#main > .item[data-key="stub-${moved.id}"]`), 'the moved item’s stub takes its place').toBeAttached();
  await expect(page.locator(`#main > .item[data-key="${moved.id}"]`), 'the moved item shows once, at the end').toHaveCount(1);
  await expect(page.locator('#main > .item').last()).toHaveAttribute('data-key', moved.id);
  const after = await seen(page);
  expect(after.newFrames.includes('App 0'), 'the app that didn’t change keeps its frame').toBe(false);
  await expect(page.frameLocator('#main iframe.app-iframe[title="App 1"]').locator('p'), 'the app with a new version shows it').toHaveText('App 1, version 2');
  const app0 = /** @type {any} */ (items.find((i) => i.block?.id === ids[0])).id;
  expect(after.newApps.includes(app0), 'the app that didn’t change keeps its node').toBe(false);
  await expect(page.locator(`#main iframe.app-iframe[title="App 1"]`)).toHaveAttribute('data-sized', '1');
});

test('#987 an app whose check changed while away, or whose item before was replaced, draws again; one that moved never shows out of order', async ({
  page,
}) => {
  const { t, ids } = await room(app, page, 'Resync, apps changed', 6, 3);
  await mark(page);
  const items = app.store.items(t.id);
  const before1 = items[items.findIndex((i) => i.block?.id === ids[1]) - 1];
  const resync = await away(app, page);
  // App 0’s check now has a problem: its look changes, though its item doesn’t.
  const a0 = app.rt.store.state.apps[ids[0]];
  app.store.emit('app', { ...a0, check: { ...a0.check, status: 'note', problems: [{ message: 'A note.' }] } });
  // The item before app 1 goes to the end: app 1’s speaker line reads a new item before it.
  arrange.moveToEnd(app.rt, t.id, before1.id, { id: `stub-${before1.id}`, what: 'app', title: 'App 0' });
  await resync();
  const after = await seen(page);
  const itemOf = (/** @type {string} */ appId) => /** @type {any} */ (items.find((i) => i.block?.id === appId)).id;
  expect(after.newApps, 'the app whose check changed draws again').toContain(itemOf(ids[0]));
  expect(after.newApps, 'the app with a new item before it draws again').toContain(itemOf(ids[1]));
  expect(after.newApps.includes(itemOf(ids[2])), 'the app that didn’t change keeps its node').toBe(false);
  expect(await order(page), 'the page’s order is the room’s').toEqual(app.store.items(t.id).map((i) => i.id));
});

test('#987 an app moved past the next one with the same item before it is drawn again, never out of order', async ({ page }) => {
  const { t, ids } = await room(app, page, 'Resync, order', 4, 2);
  await mark(page);
  const items = app.store.items(t.id);
  const a0 = items.findIndex((i) => i.block?.id === ids[0]);
  const before0 = items[a0 - 1];
  const resync = await away(app, page);
  // The item before app 0, then app 0, go to the end: app 0 still has the same item before it, but now comes after app 1.
  arrange.moveToEnd(app.rt, t.id, before0.id, { id: `stub-${before0.id}`, what: 'message', title: 'Message' });
  arrange.moveToEnd(app.rt, t.id, items[a0].id, { id: `stub-${items[a0].id}`, what: 'app', title: 'App 0' });
  await resync();
  const want = app.store.items(t.id).map((i) => i.id);
  expect(await order(page), 'the page’s order is the room’s').toEqual(want);
});

test('#987 keepable keeps an app’s node only with its record, its item before, its app and its order unchanged', async ({ page }) => {
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  const kept = await page.evaluate(async () => {
    const { keepable, noteDrawn } = await import('/app/js/resync-keep.mjs');
    const { appSig } = await import('/app/js/drawn-app.mjs');
    const { client } = await import('/app/js/client.mjs');
    const apps = client.state.apps;
    const was = { ...apps };
    const appOf = (/** @type {string} */ id) => ({ id, current: 1, versions: [{ v: 1, at: 1 }], check: { status: 'passed', problems: [] } });
    const item = (/** @type {string} */ id) => ({ id, kind: 'block', valid: true, block: { type: 'app', id: `app-${id}` } });
    const text = (/** @type {string} */ id) => ({ id, kind: 'user', text: id });
    /** The page as drawn from [P, A, Q, B], then what keepable keeps of it for a new list. */
    const run = (/** @type {any[]} */ list, /** @type {(a: any) => void} */ change = () => {}) => {
      for (const id of ['A', 'B']) apps[`app-${id}`] = appOf(`app-${id}`);
      const el = document.createElement('div');
      const nodes = new Map();
      const drawn = [text('P'), item('A'), text('Q'), item('B')];
      drawn.forEach((it, i) => {
        const n = document.createElement('div');
        n.dataset.key = it.id;
        if (it.kind === 'block') n.dataset.appSig = appSig(apps[it.block.id]);
        noteDrawn(n, it, drawn[i - 1]);
        nodes.set(it.id, n);
        el.append(n);
      });
      change(apps);
      return [...keepable(el, nodes, list, (/** @type {string} */ id) => list.findIndex((x) => x.id === id)).keys()];
    };
    const out = {
      same: run([text('P'), item('A'), text('Q'), item('B')]),
      appChanged: run(
        [text('P'), item('A'), text('Q'), item('B')],
        (a) =>
          (a['app-B'] = {
            ...a['app-B'],
            current: 2,
            versions: [
              { v: 1, at: 1 },
              { v: 2, at: 2 },
            ],
          }),
      ),
      beforeChanged: run([text('P'), item('A'), text('R'), item('B')]),
      reordered: run([text('Q'), item('B'), text('P'), item('A')]),
    };
    client.state.apps = was;
    return out;
  });
  expect(kept.same, 'unchanged, both kept').toEqual(['A', 'B']);
  expect(kept.appChanged, 'app B’s new version draws it again').toEqual(['A']);
  expect(kept.beforeChanged, 'a new item before B draws it again').toEqual(['A']);
  expect(kept.reordered, 'B now before A, each with the same item before it: one is drawn again, never moved').toEqual(['A']);
});

test('#987 an app with focus keeps its frame and the focus through a resync, in a room in its window', async ({ page }) => {
  await room(app, page, 'Resync, focused app', 300, 2);
  await mark(page);
  const frame = page.locator('#main iframe.app-iframe[title="App 1"]');
  // Tabbed into, as the person does: a frame that takes focus on its own is refused it (apps.mjs).
  await page
    .locator('#main .appframe', { has: page.locator('iframe.app-iframe[title="App 1"]') })
    .getByRole('button', { name: 'Full screen', exact: true })
    .focus();
  for (let i = 0; i < 6 && !(await frame.evaluate((f) => document.activeElement === f)); i++) await page.keyboard.press('Tab');
  await expect(frame, 'focus in the frame').toBeFocused();
  const resync = await away(app, page);
  await resync();
  const after = await seen(page);
  expect(after.newFrames, 'the focused app’s frame is the same one').toEqual([]);
  expect(after.loads, 'and it didn’t load again').toBe(0);
  await expect(frame, 'it still has the focus').toBeFocused();
});
