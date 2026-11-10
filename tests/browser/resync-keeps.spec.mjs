// A resync draws only what changed (#987). Today the page’s `load`, which a resync runs, has every open transcript
// throw away each item’s node and build it again, app frames included, so every app reloads from its start. The cases
// mark each item node and app frame before a `load` and read the marks after, as #987’s probe did:
// - with nothing changed, no item node and no app frame is replaced, and no frame loads again;
// - a changed item is still drawn from the new state;
// - an app whose version changed reloads at its new version.
// The first fails until #987 is fixed; the other two pin what the fix must keep.

import { expect, test } from '@playwright/test';
import { frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('resync-keeps');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const APP = (words) => `<main style="padding:12px;color:var(--text)"><p id="words">${words}</p></main>`;

/** A room of messages with two apps in it, open on the page, both apps drawn. */
async function room(page, title) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [rt.personaByHandle('librarian').id] });
  for (let i = 1; i <= 6; i++) rt.addItem(t.id, { kind: 'user', text: `Message ${i} in ${title}.` });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const tools = rt.toolsFor(rt.sessionsIn(t.id)[0].id);
  const apps = ['one', 'two'].map((n) => ({ id: `${n}-${t.id}`, title: `App ${n} ${title}` }));
  for (const a of apps) tools.show_app({ id: a.id, title: a.title, code: APP(`${a.title}, version 1`), permissions: [] });
  // Each app is checked before it shows, which takes longer on a loaded machine: setup mustn’t be what fails.
  for (const a of apps) await expect(frameOf(page, a.title), `${a.title} loads`).toHaveAttribute('data-sized', '1', { timeout: 15_000 });
  return { t, tools, apps };
}

/** Marks every item node and app frame of the transcript, and counts each frame’s loads from now on. */
const mark = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__loads = 0;
    for (const el of document.querySelectorAll('.transcript > [data-key]')) /** @type {any} */ (el).__kept = true;
    for (const f of document.querySelectorAll('.transcript iframe.app-iframe')) {
      /** @type {any} */ (f).__kept = true;
      f.addEventListener('load', () => w.__loads++);
    }
  });

/** The page’s own `load()`, as a resync runs it, then a moment for frames to load again. */
async function resync(page) {
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  await synced(page, app);
}

/** What of the marks is left: item nodes and frames now on the page, how many are still the marked ones, and loads since. */
const marks = (page) =>
  page.evaluate(() => {
    const items = [...document.querySelectorAll('.transcript > [data-key]')];
    const frames = [...document.querySelectorAll('.transcript iframe.app-iframe')];
    return {
      items: items.length,
      itemsKept: items.filter((el) => /** @type {any} */ (el).__kept).length,
      frames: frames.length,
      framesKept: frames.filter((f) => /** @type {any} */ (f).__kept).length,
      loads: /** @type {any} */ (window).__loads,
    };
  });

test('#987 a resync with nothing changed keeps every item node and app frame, and no app loads again', async ({ page }) => {
  await room(page, 'Unchanged');
  await mark(page);
  const before = await marks(page);
  expect(before.frames, 'both apps are on the page').toBe(2);
  await resync(page);
  // A frame that loads again does so within a frame or two of being put back; give it the time it would take.
  await expect
    .poll(() => marks(page), { message: 'every node and frame is the one marked before', timeout: 3000 })
    .toEqual({
      items: before.items,
      itemsKept: before.items,
      frames: 2,
      framesKept: 2,
      loads: 0,
    });
});

test('#987 a resync draws an item that changed from the new state', async ({ page }) => {
  const { t } = await room(page, 'Changed');
  const item = app.rt.s.items[t.id].find((it) => it.text === 'Message 3 in Changed.');
  app.store.emit('item.patch', { threadId: t.id, id: item.id, patch: { text: 'Message 3, as edited.' } });
  await resync(page);
  await expect(page.locator(`.transcript > [data-key="${item.id}"]`)).toContainText('Message 3, as edited.');
  await expect(page.locator('.transcript')).not.toContainText('Message 3 in Changed.');
});

test('#987 a resync reloads an app whose version changed, at its new version', async ({ page }) => {
  const { tools, apps } = await room(page, 'Versioned');
  const [first] = apps;
  tools.update_app({ id: first.id, code: APP(`${first.title}, version 2`) });
  await resync(page);
  await expect(frameOf(page, first.title).contentFrame().locator('#words')).toHaveText(`${first.title}, version 2`);
});

test('#987 a resync draws an item moved while the page was away at its new place, with its stub at the old one', async ({ page }) => {
  const { t, apps } = await room(page, 'Moved');
  const [first] = apps;
  const id = await frameOf(page, first.title).evaluate((f) => /** @type {HTMLElement} */ (f.closest('[data-key]')).dataset.key);
  // The way an app’s new version or a block that asks again moves its item (#49, #92): a stub takes its old place.
  expect(app.rt.bringForward(t.id, id, { what: 'app', title: first.title }), 'the item moves').toBe(true);
  await resync(page);
  const keys = await page.evaluate(() => [...document.querySelectorAll('.transcript > [data-key]')].map((el) => /** @type {HTMLElement} */ (el).dataset.key));
  const stub = app.rt.s.items[t.id].find((it) => it.kind === 'moved' && it.itemId === id);
  expect(
    keys.filter((k) => k === id),
    'the item is drawn once',
  ).toHaveLength(1);
  expect(keys.at(-1), 'and last').toBe(id);
  expect(keys, 'its stub takes its old place').toContain(stub?.id);
  expect(keys.indexOf(stub?.id), 'before the item').toBeLessThan(keys.indexOf(id));
});
