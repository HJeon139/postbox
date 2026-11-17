// #987: a resync (the page loading its state again, after a restart or a long sleep) threw away every item node of an
// open transcript and built it again, so every app’s frame reloaded and lost what it held. The page’s work on a
// resync depends on what changed now: an item whose record, place and app are the same keeps its node where it is,
// and its frame. A changed item is drawn from the new state, a moved one goes from its old place, and an app with a
// new version loads it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, newestShown, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('resync-keeps-nodes');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const BODY = (n) => `<main style="padding:12px"><p>App ${n}</p></main>`;

/**
 * A room of `messages` messages, then `apps` apps, open on the page, each app checked there and sized; returns the
 * room and its agent’s tools. @param {import('@playwright/test').Page} page
 */
async function room(page, title, messages, apps) {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title,
    personaIds: [arrange.persona(rt, 'librarian').id],
  });
  for (let i = 0; i < messages; i++) arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}` });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const ids = [];
  for (let i = 0; i < apps; i++) {
    const id = `app${i}-${t.id}`;
    tools.show_app({ id, title: `App ${i}`, code: BODY(i), permissions: [] });
    await expect.poll(() => rt.store.state.apps[id]?.check.status).toMatch(/^(passed|note)$/);
    ids.push(id);
  }
  await synced(page, app);
  await newestShown(page, app, t.id);
  await expect(page.locator('#main iframe.app-iframe[data-sized="1"]')).toHaveCount(apps);
  await settled(page);
  return { t, tools, ids };
}

/** Marks every item node and app frame on the page, and counts each frame’s loads from now on. */
const mark = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.frameLoads = 0;
    w.keysBefore = [];
    for (const n of document.querySelectorAll('#main > .item')) {
      /** @type {any} */ (n).kept = true;
      w.keysBefore.push(/** @type {HTMLElement} */ (n).dataset.key);
    }
    for (const f of document.querySelectorAll('#main iframe.app-iframe')) {
      /** @type {any} */ (f).kept = true;
      f.addEventListener('load', () => w.frameLoads++);
    }
    return document.querySelectorAll('#main iframe.app-iframe').length;
  });

/**
 * What’s on the page now: the item nodes and frames, the items that were on the page before and have a new node, the
 * new frames, and the marked frames’ loads. A window may mount a few more or fewer items around where you are.
 */
const seen = (page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('#main > .item')];
    const frames = [...document.querySelectorAll('#main iframe.app-iframe')];
    return {
      items: items.length,
      newItems: items
        .filter((n) => !(/** @type {any} */ (n).kept) && /** @type {any} */ (window).keysBefore.includes(/** @type {HTMLElement} */ (n).dataset.key))
        .map((n) => /** @type {HTMLElement} */ (n).dataset.key),
      frames: frames.length,
      newFrames: frames.filter((f) => !(/** @type {any} */ (f).kept)).map((f) => f.title),
      loads: /** @type {any} */ (window).frameLoads,
    };
  });

/** Stops the page hearing the server’s events, as a sleeping laptop’s does; returns the page’s resync. */
async function away(page) {
  await page.route('**/api/stream*', (r) => r.fulfill({ status: 204 }));
  await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect({ quiet: true })));
  return async () => {
    await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
    await page.unroute('**/api/stream*');
    await page.evaluate(() => import('/app/js/client.mjs').then(({ connect }) => connect({ quiet: true })));
    await synced(page, app);
    await settled(page);
  };
}

for (const [mode, messages] of /** @type {const} */ ([
  ['a whole room', 20],
  ['a room in its window', 300],
]))
  test(`#987 a resync with nothing changed keeps every item node and app frame, in ${mode}`, async ({ page }) => {
    await room(page, `Resync, ${mode}`, messages, 3);
    expect(await mark(page)).toBe(3);
    const resync = await away(page);
    await resync();
    const after = await seen(page);
    expect(after.newItems, 'no item node on the page was replaced').toEqual([]);
    expect(after.newFrames, 'no app frame was replaced').toEqual([]);
    expect(after.loads, 'no app frame loaded again').toBe(0);
  });

test('#987 a resync draws what changed while the page was away, and keeps the rest', async ({ page }) => {
  const { t, tools, ids } = await room(page, 'Resync with changes', 12, 2);
  await mark(page);
  const items = app.store.items(t.id);
  const changed = items[3];
  const moved = items[6];
  const resync = await away(page);
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
  // Items before the changed one, and the first app, keep their nodes; the changed item, the one after it (its speaker
  // line may change), the moved one, its stub and the new version are drawn again.
  const kept = new Set(app.store.items(t.id).map((i) => i.id));
  for (const k of after.newItems) kept.delete(k);
  expect(kept.has(items[0].id) && kept.has(items[2].id), 'items before the change keep their nodes').toBe(true);
  expect(kept.has(changed.id), 'the changed item is drawn again').toBe(false);
  await expect(page.locator(`#main iframe.app-iframe[title="App 1"]`)).toHaveAttribute('data-sized', '1');
});
